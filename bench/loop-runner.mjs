/**
 * The agent of a `loop` arm: one checked node and no parent, run inside the
 * cell's container on the package the cell installed.
 *
 * It is the fixed loop the parent was measured against (`docs/ESCALATION.md`):
 * on every parso cell the parent's first graph was one node with the task's
 * test command as its check, and after a failed node its plain re-plan was
 * the same work again, told to continue. So this runs that node, and while
 * the node fails with work done and the cell has time and budget left, runs
 * it again as a fresh graph in the same checkout. Each graph goes through
 * `runGraph` and `createPiSubprocessExecutor`, the code the parent's tool
 * calls, so the node is what a `graph` arm's node is; only the parent is
 * gone.
 *
 * This file is copied into the container and run there by the toolchain's
 * Node, so it imports nothing from the harness.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The node's ID in every graph the loop runs. */
export const LOOP_TASK_ID = "task";

/**
 * Bounds the loop on its own. The deadline and the cap end it first in any
 * real cell; this keeps a node that fails in seconds from looping unbounded.
 */
export const MAX_ATTEMPTS = 8;

/**
 * What a repeated node is told beyond its assignment, the one thing the
 * parent's plain re-plan added (`bench/DESIGN.md` **Repeats, 2026-10-01**:
 * "continue, preserve").
 */
export const CONTINUE =
  "\n\nAn earlier attempt at this task did not pass its check, and its work is still in the checkout. Continue from it rather than starting over.";

const ZERO_USAGE = () => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function addUsage(total, usage) {
  if (usage === undefined) return;
  for (const key of [
    "turns",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ]) {
    total[key] += usage[key] ?? 0;
  }
  for (const key of Object.keys(total.cost)) {
    total.cost[key] += usage.cost?.[key] ?? 0;
  }
}

/**
 * Runs the loop and returns what the cell records: why it stopped (`settled`,
 * `timeout` or `spend-cap`, as for a session), every attempt's node trace,
 * and the usage of all of them.
 *
 * A node that fails with no worker round (a check that cannot judge the task,
 * a payload the executor refuses) ends the loop: running it again would fail
 * the same way.
 */
export async function runLoop(
  request,
  { runGraph, createExecutor, now = () => Date.now() },
) {
  const deadline = now() + request.settleMs;
  const usage = ZERO_USAGE();
  const attempts = [];
  let stopped;
  while (attempts.length < MAX_ATTEMPTS) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      stopped = "timeout";
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      stopped ??= "timeout";
      controller.abort();
    }, remaining);
    let latest;
    const executor = createExecutor({
      profiles: request.profiles,
      onProgress(progress) {
        latest = progress;
        // Checked on live progress, as the parent's tool checks its graph
        // budget: one node can spend the whole cap before it returns.
        if (
          request.capUsd !== undefined &&
          stopped === undefined &&
          usage.cost.total + (progress.usage?.cost?.total ?? 0) > request.capUsd
        ) {
          stopped = "spend-cap";
          controller.abort();
        }
      },
    });
    const started = now();
    let result;
    try {
      result = await runGraph({
        stateRoot: request.stateRoot,
        workingDirectory: request.workingDirectory,
        executor,
        signal: controller.signal,
        taskTimeoutMs: Math.min(request.maxTaskMs, Math.max(1, remaining)),
        graph: {
          tasks: [
            {
              id: LOOP_TASK_ID,
              payload: {
                profile: request.profile,
                assignment:
                  attempts.length === 0
                    ? request.assignment
                    : `${request.assignment}${CONTINUE}`,
                check: request.check,
              },
            },
          ],
        },
      });
    } finally {
      clearTimeout(timer);
    }
    addUsage(usage, latest?.usage);
    attempts.push({
      runId: result.runId,
      status: result.status,
      durationMs: now() - started,
      ...(latest?.usage === undefined ? {} : { usage: latest.usage }),
      ...(latest?.check === undefined ? {} : { check: latest.check }),
      ...(latest?.rounds === undefined ? {} : { rounds: latest.rounds }),
    });
    if (stopped !== undefined || result.status === "succeeded") break;
    if ((latest?.rounds ?? []).length === 0) break;
  }
  return { outcome: stopped ?? "settled", attempts, usage };
}

/**
 * In the container: `node loop-runner.mjs <request.json> <result.json>`. The
 * request names the package's entry point, so the loop runs the build the
 * cell installed rather than one resolved from wherever this file sits.
 */
async function main([requestPath, resultPath]) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const { runGraph, createPiSubprocessExecutor, RUN_GRAPH_LIMITS } =
    await import(pathToFileURL(request.packageEntry).href);
  // The package's own ceiling: a node may not run longer, so a longer cell
  // runs more attempts rather than one longer node.
  const maxTaskMs = RUN_GRAPH_LIMITS.maxTaskRuntimeMs;
  const result = await runLoop(
    { ...request, maxTaskMs },
    {
      runGraph,
      createExecutor: createPiSubprocessExecutor,
    },
  );
  await writeFile(resultPath, `${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
