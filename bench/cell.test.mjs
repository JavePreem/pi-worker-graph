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

test("a failing target's output survives into the record", async () => {
  // A cell reporting `fail: build failed` and nothing else cannot say whether
  // the model could not do the task or never compiled its own edit, and the
  // container is gone by the time anyone asks.
  const record = await run({
    grade: async () => ({
      resolved: false,
      outcome: "unresolved",
      states: {
        "//a:test": {
          state: "fail",
          reason: "build failed",
          tail: "Executed 0 out of 1 test",
          errorTail: "ERROR: types.ts(12,3): error TS2339",
        },
        "//b:test": { state: "pass", reason: "passed", tail: "all good" },
      },
    }),
  });
  assert.match(record.detail.targetFailures["//a:test"], /TS2339/);
  assert.match(record.detail.targetFailures["//a:test"], /Executed 0 out of 1/);
  assert.equal("//b:test" in record.detail.targetFailures, false);
});

test("a resolved cell carries no failure text at all", async () => {
  const record = await run({
    grade: async () => ({
      resolved: true,
      outcome: "resolved",
      states: { "//a:test": { state: "pass", reason: "passed", tail: "ok" } },
    }),
  });
  assert.equal("targetFailures" in record.detail, false);
});

test("a test-patch conflict names the files git apply refused", async () => {
  const record = await run({
    grade: async () => ({
      resolved: false,
      outcome: "test-patch-conflict",
      detail: "error: a_spec.ts: patch does not apply",
      conflicted: ["packages/compiler/test/a_spec.ts"],
      states: {},
    }),
  });
  assert.deepEqual(record.detail.conflictedFiles, [
    "packages/compiler/test/a_spec.ts",
  ]);
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

test("a settled turn that spent nothing is not attempted, not a loss", async () => {
  // The failure it guards, seen live on the first trial cell: Pi accepted the
  // model and the prompt, settled in seconds, and reported zero tokens. The
  // harness graded the untouched checkout and called it an unresolved task.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      settle: async () => ({
        outcome: "settled",
        stats: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
      }),
      grade: async () => {
        throw new Error("a cell that never ran must not be graded");
      },
    }),
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "no-agent-turn");
  assert.equal(record.costUsd, 0);
});

test("absent telemetry is not read as a spend of zero", async () => {
  // Unknown and zero are different claims; only zero is evidence the agent
  // never ran, and the runtime keeps them apart for the same reason.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      settle: async () => ({ outcome: "settled", stats: undefined }),
    }),
  });
  assert.notEqual(record.outcome, "no-agent-turn");
});

test("a trial is handed the session transcript before the client closes", async () => {
  let captured;
  await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    onEvents: async (c) => {
      captured = c;
    },
    deps: deps({
      openAgentSession: async () =>
        fakeClient({ events: [{ type: "e" }], toolCalls: [{ name: "t" }] }),
    }),
  });
  assert.deepEqual(captured.events, [{ type: "e" }]);
  assert.deepEqual(captured.toolCalls, [{ name: "t" }]);
  // No broker on an unconfined cell, so nothing to say about its relay.
  assert.equal(captured.brokerLog, undefined);
});

test("the credentials are removed from the container before grading runs", async () => {
  // auth.json is real and the image is someone else's. Grading is the largest
  // quantity of third-party code the cell runs, and it runs as root.
  const commands = [];
  const container = {
    ...fakeContainer(),
    exec: async (script) => {
      commands.push(script);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      start: async () => container,
      grade: async () => {
        commands.push("GRADE");
        return { resolved: true, outcome: "resolved", states: {} };
      },
    }),
  });
  const scrubbed = commands.findIndex((c) => c.includes("rm -rf"));
  const graded = commands.indexOf("GRADE");
  assert.ok(scrubbed !== -1, "agent directory was never removed");
  assert.ok(scrubbed < graded, "credentials were still present during grading");
});

test("a cell that fails mid-flight still removes the credentials", async () => {
  const commands = [];
  const container = {
    ...fakeContainer(),
    exec: async (script) => {
      commands.push(script);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      start: async () => container,
      settle: async () => {
        throw new Error("provider exploded");
      },
    }),
  });
  assert.equal(record.class, "not-attempted");
  assert.ok(commands.some((c) => c.includes("rm -rf")));
});

test("a confined cell's container is put on the broker's network", async () => {
  // The only wiring of the two, and it is what makes confinement real rather
  // than merely started.
  let network;
  await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    egressAllowHost: "provider.example",
    deps: deps({
      startBroker: async () => ({
        network: "cell_net",
        logs: async () => "",
        stop: async () => {},
      }),
      start: async (_image, options) => {
        network = options?.network;
        return fakeContainer();
      },
    }),
  });
  assert.equal(network, "cell_net");
});

test("an unconfined cell starts no broker and names no network", async () => {
  let started = false;
  let network = "unset";
  await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      startBroker: async () => {
        started = true;
        return { network: "n", logs: async () => "", stop: async () => {} };
      },
      start: async (_image, options) => {
        network = options?.network;
        return fakeContainer();
      },
    }),
  });
  assert.equal(started, false);
  assert.equal(network, undefined);
});

test("the broker is torn down after the container that is attached to it", async () => {
  const order = [];
  await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    egressAllowHost: "provider.example",
    deps: deps({
      startBroker: async () => ({
        network: "cell_net",
        logs: async () => "",
        stop: async () => order.push("broker"),
      }),
      start: async () => ({
        ...fakeContainer(),
        stop: async () => order.push("container"),
      }),
    }),
  });
  assert.deepEqual(order, ["container", "broker"]);
});

test("a trial keeps its measurement when the transcript cannot be written", async () => {
  // By then the cell has run and been paid for. Losing the usage and the diff
  // to report that a file could not be written is the wrong trade.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    onEvents: async () => {
      throw new Error("ENOSPC");
    },
    deps: deps(),
  });
  assert.equal(record.class, "resolved");
  assert.equal(record.costUsd, 1.25);
});

test("a record says which host the cell was confined to, or that it was not", async () => {
  // A stored cell outlives the console line that announced the mode, and a
  // run with open egress is not the same measurement as a confined one.
  const confined = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    egressAllowHost: "provider.example",
    deps: deps({
      startBroker: async () => ({
        network: "n",
        logs: async () => "relay up",
        stop: async () => {},
      }),
    }),
  });
  assert.equal(confined.egress, "provider.example");
  assert.equal((await run()).egress, "open");
});

test("a cell that never settled carries the relay's account of why", async () => {
  // A relay nothing could connect through hangs the agent instead of failing
  // it, so the timeout record is exactly where that log is needed.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    egressAllowHost: "provider.example",
    deps: deps({
      startBroker: async () => ({
        network: "n",
        logs: async () => "relay up -> 203.0.113.7",
        stop: async () => {},
      }),
      settle: async () => ({
        outcome: "timeout",
        stats: { cost: 0.5, tokens: { total: 4 } },
      }),
    }),
  });
  assert.equal(record.outcome, "timeout");
  assert.equal(record.brokerLog, "relay up -> 203.0.113.7");
});

test("an unconfined cell's record carries no broker log at all", async () => {
  assert.equal("brokerLog" in (await run()), false);
});

test("a transcript handler that is not async still cannot lose the cell", async () => {
  // `onEvents?.(...).catch()` is itself a TypeError when the handler returns
  // no promise, which the harness would then report as a cell that failed.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    onEvents: () => {
      throw new Error("sync boom");
    },
    deps: deps(),
  });
  assert.equal(record.class, "resolved");
});

test("a runaway diff is bounded, and says what it dropped", async () => {
  // Whatever the agent writes lands in the record and then in an append-only
  // store that keeps it for good. One generated file would otherwise be
  // permanent.
  const huge = `${"x".repeat(3 * 1024 * 1024)}\n`;
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    deps: deps({
      start: async () => ({
        ...fakeContainer(),
        exec: async () => ({ code: 0, stdout: huge, stderr: "" }),
      }),
    }),
  });
  assert.ok(record.diff.length < huge.length);
  assert.match(record.diff, /diff truncated by the harness: 3145729 bytes/);
});

test("a record says which provider served it", async () => {
  // A queued cell's provider is in the manifest; a trial has none, so without
  // this a saved trial record cannot say what it measured against.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "solo-luna", repetition: 1 },
    manifest,
    provider: "azure-openai-responses",
    deps: deps(),
  });
  assert.equal(record.provider, "azure-openai-responses");
});

const STARTUP = "Pi worker process failed to start";

/**
 * A `worker_graph` result in the shape the tool really returns: one answer for
 * the whole graph, with a status line per node and every node's review as JSON
 * (`finalText` in `src/orchestrator.ts`). The tests below turn on the
 * difference between one node failing and all of them, so the fixture has to
 * carry the per-node structure rather than a blob with the diagnostic in it.
 */
function graphResult(nodes) {
  return [
    `Worker graph finished. Run ID: x`,
    ...nodes.map((n) => `${n.taskId}: ${n.status}`),
    "<worker_graph_reports_json>",
    JSON.stringify(nodes),
    "</worker_graph_reports_json>",
  ].join("\n");
}

test("a graph arm whose workers never started is not scored", async () => {
  // Seen live: four worker_graph calls, every one "Pi worker process failed to
  // start", no diff, every graph one task. Indistinguishable in the record
  // from a model that declined to fan out, and the opposite conclusion.
  const failed = graphResult([
    { taskId: "investigate", status: "failed", diagnostics: STARTUP },
  ]);
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "graph-luna", repetition: 1 },
    manifest,
    deps: deps({
      openAgentSession: async () =>
        fakeClient({
          toolCalls: [
            { toolName: "worker_graph", text: failed },
            { toolName: "worker_graph", text: failed },
          ],
        }),
      grade: async () => {
        throw new Error("a cell whose workers never ran must not be graded");
      },
    }),
  });
  assert.equal(record.class, "not-attempted");
  assert.equal(record.outcome, "workers-never-started");
  // The spend still happened and is still recorded.
  assert.equal(record.costUsd, 1.25);
});

test("one worker failing to start does not discard the other three", async () => {
  // The result is one blob for the whole graph, so a substring match on the
  // startup diagnostic is true the moment any single node fails. Three workers
  // ran here and the diff resolves the instance; that is a measurement, not a
  // broken harness.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "graph-luna", repetition: 1 },
    manifest,
    deps: deps({
      openAgentSession: async () =>
        fakeClient({
          toolCalls: [
            {
              toolName: "worker_graph",
              text: graphResult([
                { taskId: "a", status: "failed", diagnostics: STARTUP },
                { taskId: "b", status: "succeeded" },
                { taskId: "c", status: "succeeded" },
                { taskId: "d", status: "succeeded" },
              ]),
            },
          ],
        }),
    }),
  });
  assert.equal(record.class, "resolved");
});

test("a graph blocked behind a worker that never started is not scored", async () => {
  // The root fails at startup and its dependants are never dispatched, so they
  // carry no diagnostic of their own. No worker ran all the same.
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "graph-luna", repetition: 1 },
    manifest,
    deps: deps({
      openAgentSession: async () =>
        fakeClient({
          toolCalls: [
            {
              toolName: "worker_graph",
              text: graphResult([
                { taskId: "a", status: "failed", diagnostics: STARTUP },
                { taskId: "b", status: "blocked" },
              ]),
            },
          ],
        }),
      grade: async () => {
        throw new Error("a cell whose workers never ran must not be graded");
      },
    }),
  });
  assert.equal(record.outcome, "workers-never-started");
});

test("a graph arm whose workers ran is scored normally", async () => {
  const record = await runCell({
    instance,
    cell: { task: "i1", arm: "graph-luna", repetition: 1 },
    manifest,
    deps: deps({
      openAgentSession: async () =>
        fakeClient({
          toolCalls: [
            { toolName: "worker_graph", text: "implement: succeeded" },
          ],
        }),
    }),
  });
  assert.equal(record.class, "resolved");
});
