/**
 * The per-instance Docker environment a cell runs in.
 *
 * ProMax ships a built checkout per instance -- `node_modules` installed and a
 * warm Bazel cache -- so there is no setup step, but the checkout only exists
 * inside the image. The agent therefore runs in the container rather than on
 * the host: `pi-worker-graph` spawns worker subprocesses in the target
 * checkout, and a worker that cannot reach the checkout is not the package
 * under test.
 *
 * Exit codes are read from the process, never from text. The validation sweep
 * piped Bazel through `tail` and had to infer pass from wording; here nothing
 * is piped, so the code is available and the wording is only for the record.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export const TESTBED = "/testbed";

// Bazel sizes its own parallelism from the host and will take every core and
// most of the RAM. Capping it is what lets a cell run on a small box; grading
// is not the slow part, the image pull is.
export const DEFAULT_LIMITS = {
  memory: process.env.BENCH_MEM ?? "6g",
  cpus: process.env.BENCH_CPUS ?? "4",
};

function run(args, { timeoutMs = 1_800_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function pullImage(image, { timeoutMs = 2_400_000 } = {}) {
  const result = await run(["docker", "pull", image], { timeoutMs });
  if (result.code !== 0)
    throw new Error(`docker pull ${image}: ${result.stderr.slice(-400)}`);
}

/**
 * Drop an image once its instance is done.
 *
 * An image is ~14 GB unpacked, so a sweep that keeps them accumulates faster
 * than the backing disk gives space back. A prune of dangling layers was tried
 * here and removed: it reclaimed 0B on every instance of a six-instance sweep,
 * because `docker rmi` on a tagged image with no other references already
 * drops its layers -- and a prune would have been free to remove another
 * project's dangling layers on a shared box, which is not the bench's to do.
 */
export async function removeImage(image) {
  await run(["docker", "rmi", "-f", image], { timeoutMs: 600_000 });
}

function memAvailableKb() {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Wait until the host has memory again before pulling the next image.
 *
 * Four runs on a 13 GB development box were killed for host memory, always
 * during the pull and never during the grading. **Why is not settled.** Page
 * cache from unpacking ~14 GB is the suspect, but the sweep that first
 * completed did so without this wait ever engaging, so nothing here is shown
 * to be the cure. It is cheap insurance against a documented failure: it
 * touches nothing, and when the memory does not come back it says so and
 * proceeds rather than becoming a stall of its own.
 */
export async function awaitHeadroom({
  minFreeKb = Number(process.env.BENCH_MIN_FREE_GB ?? 5) * 1024 * 1024,
  waitMs = Number(process.env.BENCH_HEADROOM_WAIT_S ?? 300) * 1000,
  pollMs = 15_000,
  onWait = () => {},
} = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const available = memAvailableKb();
    if (available === null || available >= minFreeKb) return available;
    if (Date.now() >= deadline) {
      onWait(available, true);
      return available;
    }
    onWait(available, false);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * A running container for one instance. `sleep infinity` rather than the
 * image's own entrypoint: the cell drives it through a series of exec calls
 * and needs it to outlive each one.
 */
export async function startContainer(
  image,
  { name, limits = DEFAULT_LIMITS } = {},
) {
  await run(["docker", "rm", "-f", name], { timeoutMs: 120_000 });
  const started = await run([
    "docker",
    "run",
    "-d",
    "--memory",
    limits.memory,
    "--cpus",
    limits.cpus,
    "--name",
    name,
    image,
    "sleep",
    "infinity",
  ]);
  if (started.code !== 0)
    throw new Error(`docker run ${image}: ${started.stderr.slice(-400)}`);

  return {
    name,
    image,
    exec: (script, options) =>
      run(["docker", "exec", name, "bash", "-lc", script], options),
    /** Write a file inside the container without a host temporary file. */
    write: async (containerPath, contents) => {
      const result = await run(
        [
          "docker",
          "exec",
          "-i",
          name,
          "bash",
          "-c",
          `cat > ${JSON.stringify(containerPath)}`,
        ],
        { input: contents },
      );
      if (result.code !== 0) {
        throw new Error(`write ${containerPath}: ${result.stderr.slice(-400)}`);
      }
    },
    copyIn: async (hostPath, containerPath) => {
      const result = await run(
        ["docker", "cp", hostPath, `${name}:${containerPath}`],
        {
          timeoutMs: 600_000,
        },
      );
      if (result.code !== 0) {
        throw new Error(`docker cp ${hostPath}: ${result.stderr.slice(-400)}`);
      }
    },
    stop: () => run(["docker", "rm", "-f", name], { timeoutMs: 120_000 }),
  };
}

/**
 * Apply a patch inside the checkout. Kept separate from a plain exec because
 * the failure is meaningful: a `test_patch` that will not apply after the
 * agent ran means the agent edited the tests, which is a grading outcome
 * rather than a harness fault.
 */
export async function applyPatch(container, diff, { label }) {
  const file = `/tmp/${label}.diff`;
  await container.write(file, diff);
  const result = await container.exec(`cd ${TESTBED} && git apply ${file}`, {
    timeoutMs: 300_000,
  });
  return { applied: result.code === 0, detail: result.stderr.slice(-400) };
}
