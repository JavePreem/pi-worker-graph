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

export async function removeImage(image) {
  await run(["docker", "rmi", "-f", image], { timeoutMs: 600_000 });
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
