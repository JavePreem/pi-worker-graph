import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUE,
  LOOP_TASK_ID,
  MAX_ATTEMPTS,
  runLoop,
} from "./loop-runner.mjs";

const request = {
  stateRoot: "/state",
  workingDirectory: "/testbed",
  profiles: { worker: { model: "luna" } },
  profile: "worker",
  assignment: "Restore the functions.",
  check: { commands: ["pytest"], frozen: ["test"], maxRounds: 4 },
  settleMs: 3_600_000,
  maxTaskMs: 1_800_000,
};

const usage = (total) => ({
  turns: 1,
  input: 10,
  output: 2,
  cacheRead: 100,
  cacheWrite: 5,
  totalTokens: 117,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const workRound = { kind: "work", durationMs: 1, blockers: 0 };

/**
 * A fake package: each graph plays the next scripted attempt, sending its
 * progress through the executor's `onProgress` as the real one does.
 */
function fakePackage(attempts) {
  const graphs = [];
  let onProgress;
  return {
    graphs,
    createExecutor: (options) => {
      onProgress = options.onProgress;
      return { options };
    },
    runGraph: async (options) => {
      const attempt = attempts[graphs.length];
      graphs.push(options);
      for (const progress of attempt.progress ?? []) {
        onProgress({ taskId: LOOP_TASK_ID, ...progress });
      }
      return {
        runId: `run-${graphs.length}`,
        status: options.signal.aborted ? "aborted" : attempt.status,
        nodes: [],
      };
    },
  };
}

const failedWithWork = (cost) => ({
  status: "failed",
  progress: [
    {
      phase: "finished",
      usage: usage(cost),
      check: { outcome: "failed", runs: 4, commands: 1, failingBefore: 1 },
      rounds: [workRound],
    },
  ],
});

const passed = (cost) => ({
  status: "succeeded",
  progress: [
    {
      phase: "finished",
      usage: usage(cost),
      check: { outcome: "passed", runs: 2, commands: 1, failingBefore: 1 },
      rounds: [workRound],
    },
  ],
});

test("a node that passes its check ends the loop as a settled cell", async () => {
  const pkg = fakePackage([passed(0.2)]);
  const result = await runLoop(request, pkg);
  assert.equal(result.outcome, "settled");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, "succeeded");
  assert.equal(result.attempts[0].check.outcome, "passed");
  assert.equal(result.usage.cost.total, 0.2);
  const [graph] = pkg.graphs;
  assert.deepEqual(graph.graph.tasks, [
    {
      id: LOOP_TASK_ID,
      payload: {
        profile: "worker",
        assignment: "Restore the functions.",
        check: request.check,
      },
    },
  ]);
  assert.equal(graph.stateRoot, "/state");
  assert.equal(graph.workingDirectory, "/testbed");
  assert.equal(graph.taskTimeoutMs, 1_800_000);
});

test("a node that fails with work done runs again, told to continue, and spend adds up", async () => {
  const pkg = fakePackage([failedWithWork(0.2), passed(0.1)]);
  const result = await runLoop(request, pkg);
  assert.equal(result.outcome, "settled");
  assert.deepEqual(
    result.attempts.map((a) => a.status),
    ["failed", "succeeded"],
  );
  assert.equal(
    pkg.graphs[1].graph.tasks[0].payload.assignment,
    `Restore the functions.${CONTINUE}`,
  );
  assert.ok(Math.abs(result.usage.cost.total - 0.3) < 1e-9);
  assert.equal(result.usage.cacheRead, 200);
  assert.equal(result.usage.totalTokens, 234);
});

test("a node that failed before any worker ran is not run again", async () => {
  const pkg = fakePackage([
    {
      status: "failed",
      progress: [
        {
          phase: "finished",
          usage: usage(0),
          check: { outcome: "unjudgeable", runs: 0, commands: 1 },
          rounds: [],
        },
      ],
    },
  ]);
  const result = await runLoop(request, pkg);
  assert.equal(result.outcome, "settled");
  assert.equal(result.attempts.length, 1);
});

test("live spend past the cap aborts the graph and stops the cell on its cap", async () => {
  const pkg = fakePackage([failedWithWork(0.5), failedWithWork(0.6)]);
  const result = await runLoop({ ...request, capUsd: 1 }, pkg);
  assert.equal(result.outcome, "spend-cap");
  assert.equal(result.attempts.length, 2);
  assert.equal(pkg.graphs[1].signal.aborted, true);
  assert.equal(result.attempts[1].status, "aborted");
});

test("a node's timeout is what is left of the cell, at most the package's ceiling", async () => {
  let clock = 0;
  const pkg = fakePackage([failedWithWork(0.1), failedWithWork(0.1)]);
  const runGraph = pkg.runGraph;
  pkg.runGraph = async (options) => {
    const result = await runGraph(options);
    clock += 1_000_000;
    return result;
  };
  const result = await runLoop(
    { ...request, settleMs: 1_500_000 },
    { ...pkg, now: () => clock },
  );
  assert.deepEqual(
    pkg.graphs.map((g) => g.taskTimeoutMs),
    [1_500_000, 500_000],
  );
  assert.equal(result.outcome, "timeout");
  assert.equal(result.attempts.length, 2);
});

test("the loop is bounded even when every node fails fast", async () => {
  const pkg = fakePackage(
    Array.from({ length: MAX_ATTEMPTS + 2 }, () => failedWithWork(0)),
  );
  const result = await runLoop(request, pkg);
  assert.equal(result.attempts.length, MAX_ATTEMPTS);
  assert.equal(result.outcome, "settled");
});
