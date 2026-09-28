import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Bounds on a node's check. `maxRounds` counts check runs after the work, as a
 * review policy counts review passes: a check of 2 admits work, check,
 * repair, check. The run before the work is not a round.
 *
 * The output tail is what a repair round and a failed node's report see of a
 * failing command. It is a tail because test runners end on their summary, and
 * a worker that needs more can run the command itself — the repair names it.
 */
export const CHECK_LIMITS = Object.freeze({
  maxCommands: 8,
  maxCommandBytes: 1024,
  maxRounds: 4,
  outputTailBytes: 2 * 1024,
  maxFrozenPaths: 32,
  maxFrozenPathBytes: 4 * 1024,
  maxFrozenFiles: 4096,
});

/**
 * What the check must do before any work, which is what makes it able to
 * judge the work at all. A check for new behaviour must fail first: one that
 * already passes would accept the task with nothing done. A check guarding
 * behaviour that must not change must pass first: one already failing cannot
 * say whether the work broke anything.
 */
export type CheckBefore = "fail" | "pass";

export interface CheckPolicy {
  readonly commands: readonly string[];
  readonly maxRounds: number;
  readonly before?: CheckBefore;
  /** Repository-relative paths the work must leave byte-identical. */
  readonly frozen?: readonly string[];
}

/** Whether a frozen path stays inside the checkout it is named relative to. */
export function isContainedPath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]/u).includes("..");
}

/**
 * Runs one command in a shell from `workingDirectory` and resolves to a
 * finding when it fails, or `undefined` when it exits 0.
 *
 * The command gets no stdin and its combined output is kept only as a bounded
 * tail. On POSIX it leads its own process group, so an abort takes down
 * anything it started, the same way a worker process is stopped.
 */
function runCommand(
  command: string,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > CHECK_LIMITS.outputTailBytes) {
        tail = tail.subarray(tail.length - CHECK_LIMITS.outputTailBytes);
      }
    };
    const child = spawn(command, {
      cwd: workingDirectory,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stop = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const finish = (outcome: string | undefined) => {
      signal.removeEventListener("abort", stop);
      resolve(outcome);
    };
    child.on("error", () =>
      finish(`Check command could not start: ${command}`),
    );
    child.on("close", (code, killedBy) => {
      if (code === 0) return finish(undefined);
      const output = tail.toString("utf8").trim();
      finish(
        [
          `Check command failed: ${command}`,
          code === null ? `Killed by ${killedBy}` : `Exit code: ${code}`,
          ...(output.length === 0
            ? []
            : [
                `Last ${CHECK_LIMITS.outputTailBytes} bytes of output:`,
                output,
              ]),
        ].join("\n"),
      );
    });
  });
}

/**
 * Runs every check command in order and returns each one's outcome, in the
 * same order: a finding for a failing command, `undefined` for a passing one.
 *
 * All of them run even after one fails, so a repair round sees every failing
 * check at once rather than discovering them one round at a time. They run in
 * sequence because two test commands in one checkout can collide.
 */
export async function runCheck(
  policy: CheckPolicy,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<readonly (string | undefined)[]> {
  const outcomes: (string | undefined)[] = [];
  for (const command of policy.commands) {
    if (signal.aborted) break;
    outcomes.push(await runCommand(command, workingDirectory, signal));
  }
  return outcomes;
}

/**
 * Fingerprints each frozen path: a file by its bytes, a symbolic link by its
 * target (never followed), a directory by every entry beneath it, and a
 * missing path as missing, so creating it counts as a change.
 *
 * Throws when a directory holds more than `maxFrozenFiles` entries: a
 * fingerprint that silently covered part of a tree would pass tampering with
 * the rest.
 */
export async function fingerprintPaths(
  workingDirectory: string,
  paths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  let files = 0;
  const fingerprint = async (absolute: string): Promise<string> => {
    const stats = await lstat(absolute).catch(() => undefined);
    if (stats === undefined) return "missing";
    files += 1;
    if (files > CHECK_LIMITS.maxFrozenFiles) {
      throw new Error("Frozen paths hold too many files to fingerprint");
    }
    if (stats.isSymbolicLink()) return `link:${await readlink(absolute)}`;
    if (stats.isDirectory()) {
      const hash = createHash("sha256");
      const names = (await readdir(absolute)).sort();
      for (const name of names) {
        hash.update(`${name}\0${await fingerprint(join(absolute, name))}\0`);
      }
      return `dir:${hash.digest("hex")}`;
    }
    return `file:${createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex")}`;
  };
  const result = new Map<string, string>();
  for (const path of paths) {
    result.set(path, await fingerprint(join(workingDirectory, path)));
  }
  return result;
}
