import assert from "node:assert/strict";
import test from "node:test";

import { workerGraphConfig } from "./arms.mjs";
import { NotAttempted, runCell, settleWithSpendCap } from "./cell.mjs";
import { createManifest } from "./queue.mjs";

const manifest = createManifest({
  taskIds: ["i1"],
  seed: 1,
  harnessVersion: "h",
  packageVersion: "p",
});

const instance = {
  id: "i1",
  targets: ["//a:test"],
  regressionTargets: [],
  row: {
    image_name: "example/image",
    problem_statement: "fix the thing",
    test_patch: "diff",
  },
};

const fakeContainer = () => ({
  name: "c",
  exec: async () => ({ code: 0, stdout: "diff --git a/x b/x\n", stderr: "" }),
  write: async () => {},
  copyIn: async () => {},
  stop: async () => {},
});

const fakeClient = (over = {}) => ({
  events: [],
  toolCalls: [],
  close: async () => {},
  ...over,
});

function deps(over = {}) {
  return {
    pull: async () => {},
    start: async () => fakeContainer(),
    install: async () => {},
    agentDirectory: async () => ({
      dir: "/tmp/agent",
      dispose: async () => {},
    }),
    openAgentSession: async () => fakeClient(),
    settle: async () => ({
      outcome: "settled",
      stats: { cost: 1.25, tokens: { total: 10 } },
    }),
    grade: async () => ({ resolved: true, outcome: "resolved", states: {} }),
    dropImage: false,
    ...over,
  };
}

const run = (
  over = {},
  cell = { task: "i1", arm: "solo-sol", repetition: 1 },
) => runCell({ instance, cell, manifest, deps: deps(over) });

test("a settled and graded cell records the cost it spent", async () => {
  const record = await run();
  assert.equal(record.class, "resolved");
  assert.equal(record.costUsd, 1.25);
  assert.deepEqual(record.usage, { total: 10 });
  assert.equal(record.diff.startsWith("diff --git"), true);
});

test("an instance the agent did not fix is a result, not a harness failure", async () => {
  const record = await run({
    grade: async () => ({ resolved: false, outcome: "unresolved", states: {} }),
  });
  assert.equal(record.class, "not-resolved");
  assert.equal(record.outcome, "unresolved");
});

test("a container that will not start is not attempted", async () => {
  const record = await run({
    start: async () => {
      throw new Error("no such image");
    },
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "harness");
  assert.match(record.detail, /no such image/);
});

test("a refused prompt names itself rather than becoming a harness error", async () => {
  const record = await run({
    settle: async () => {
      throw new NotAttempted("prompt refused", "{}");
    },
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "prompt refused");
});

test("a cell stopped by its spend cap is not attempted, and its cost is still recorded", async () => {
  const record = await run({
    settle: async () => ({
      outcome: "spend-cap",
      stats: { cost: 9.99, tokens: { total: 5 } },
    }),
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "spend-cap");
  assert.equal(record.costUsd, 9.99);
});

test("a timed-out cell is not scored either", async () => {
  const record = await run({
    settle: async () => ({ outcome: "timeout", stats: { cost: 3 } }),
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "timeout");
});

test("a grading run that could not be performed is not a loss for the arm", async () => {
  const record = await run({
    grade: async () => ({
      resolved: false,
      outcome: "harness",
      detail: "ungraded targets",
    }),
  });
  assert.equal(record.class, "not-attempted");
});

test("a graph arm is given a worker-graph configuration and a solo arm is not", async () => {
  const seen = [];
  const capture = {
    agentDirectory: async ({ workerGraphConfig: config }) => {
      seen.push(config);
      return { dir: "/tmp/agent", dispose: async () => {} };
    },
  };
  await run(capture, { task: "i1", arm: "solo-sol", repetition: 1 });
  await run(capture, { task: "i1", arm: "graph-luna", repetition: 1 });
  assert.equal(seen[0], undefined);
  assert.equal(seen[1].profiles.worker.model, "gpt-5.6-luna");
  assert.equal(seen[1].profiles.reviewer.model, "gpt-5.6-sol");
});

test("the reviewer profile holds no tool that can change the checkout", () => {
  const config = workerGraphConfig("graph-luna");
  for (const tool of config.profiles.reviewer.tools) {
    assert.equal(
      ["edit", "write", "bash"].includes(tool),
      false,
      `reviewer holds ${tool}`,
    );
  }
});

test("the spend cap stops a run that crosses it rather than waiting for settle", async () => {
  let polls = 0;
  const client = {
    settledMark: 0,
    send: async (command) => {
      if (command.type === "prompt") return { success: true };
      polls += 1;
      return {
        success: true,
        data: { cost: polls * 4, tokens: { total: polls } },
      };
    },
    waitSettled: async () => "timeout",
  };
  const result = await settleWithSpendCap(client, {
    prompt: "go",
    settleMs: 60_000,
    capUsd: 5,
    pollMs: 1,
  });
  assert.equal(result.outcome, "spend-cap");
  assert.equal(result.stats.cost, 8);
});

test("a run that settles under its cap settles normally", async () => {
  const client = {
    settledMark: 0,
    send: async (command) =>
      command.type === "prompt"
        ? { success: true }
        : { success: true, data: { cost: 0.5, tokens: { total: 1 } } },
    waitSettled: async () => "settled",
  };
  const result = await settleWithSpendCap(client, {
    prompt: "go",
    settleMs: 60_000,
    capUsd: 5,
    pollMs: 1,
  });
  assert.equal(result.outcome, "settled");
  assert.equal(result.stats.cost, 0.5);
});

test("a prompt the session refuses never becomes a task failure", async () => {
  const client = {
    settledMark: 0,
    send: async () => ({ success: false, error: "busy" }),
    waitSettled: async () => "settled",
  };
  await assert.rejects(
    () => settleWithSpendCap(client, { prompt: "go", settleMs: 1000 }),
    (error) =>
      error instanceof NotAttempted && error.reason === "prompt refused",
  );
});
