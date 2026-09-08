import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  GraphRequest,
  GraphRunResult,
  NodeOutput,
  TaskExecutionInput,
  TaskExecutionResult,
  TaskExecutor,
} from "../src/index.js";
import {
  GraphValidationError,
  NODE_OUTPUT_LIMITS,
  RUN_GRAPH_LIMITS,
  RunGraphValidationError,
  readNodeOutput,
  readNodeState,
  runGraph,
} from "../src/index.js";
import { nodeOutput } from "./fixtures.js";

async function temporaryStateRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-graph-run-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function statuses(result: GraphRunResult): Record<string, string> {
  return Object.fromEntries(
    result.nodes.map((node) => [node.taskId, node.status]),
  );
}

test("runs independent tasks concurrently up to the configured limit", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let active = 0;
  let maximumActive = 0;
  let releaseOverlap: () => void = () => {};
  const overlap = new Promise<void>((resolveOverlap) => {
    releaseOverlap = resolveOverlap;
  });
  const started: string[] = [];
  const executor: TaskExecutor = async (input) => {
    started.push(input.taskId);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) releaseOverlap();
    await overlap;
    active -= 1;
    return { output: nodeOutput(`Completed ${input.taskId}`) };
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [{ id: "d" }, { id: "b" }, { id: "a" }, { id: "c" }],
      concurrency: 2,
    },
    workingDirectory: stateRoot,
    executor,
    taskTimeoutMs: 10_000,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(maximumActive, 2);
  assert.deepEqual(started.slice(0, 2), ["a", "b"]);
  assert.deepEqual(
    result.nodes.map((node) => node.taskId),
    ["d", "b", "a", "c"],
  );
  assert.deepEqual(statuses(result), {
    d: "succeeded",
    b: "succeeded",
    a: "succeeded",
    c: "succeeded",
  });
});

test("passes only durable direct-prerequisite outputs", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const workingDirectory = join(stateRoot, "checkout");
  const received = new Map<string, TaskExecutionInput>();
  const executor: TaskExecutor = async (input) => {
    received.set(input.taskId, input);
    for (const prerequisite of input.prerequisites) {
      assert.equal(
        (await readNodeState(stateRoot, input.runId, prerequisite.taskId))
          .status,
        "succeeded",
      );
      assert.deepEqual(
        (await readNodeOutput(stateRoot, input.runId, prerequisite.taskId))
          .output,
        prerequisite.output,
      );
    }
    return { output: nodeOutput(`Completed ${input.taskId}`) };
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [
        { id: "root", payload: { assignment: "root work" } },
        { id: "middle", needs: ["root"] },
        { id: "side" },
        { id: "leaf", needs: ["side", "middle"] },
      ],
      concurrency: 3,
    },
    workingDirectory,
    executor,
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(received.get("root")?.prerequisites, []);
  assert.equal(received.get("root")?.prerequisiteContext, "");
  assert.deepEqual(received.get("root")?.payload, {
    assignment: "root work",
  });
  assert.deepEqual(received.get("middle")?.prerequisites, [
    { taskId: "root", output: nodeOutput("Completed root") },
  ]);
  assert.match(
    received.get("middle")?.prerequisiteContext ?? "",
    /"taskId":"root".*"summary":"Completed root"/,
  );
  assert.deepEqual(received.get("leaf")?.prerequisites, [
    { taskId: "middle", output: nodeOutput("Completed middle") },
    { taskId: "side", output: nodeOutput("Completed side") },
  ]);
  const leafContext = received.get("leaf")?.prerequisiteContext ?? "";
  assert.ok(leafContext.indexOf('"taskId":"middle"') >= 0);
  assert.ok(
    leafContext.indexOf('"taskId":"middle"') <
      leafContext.indexOf('"taskId":"side"'),
  );
  assert.equal(leafContext.includes("Completed root"), false);
  assert.equal(
    received.get("leaf")?.workingDirectory,
    resolve(workingDirectory),
  );
});

test("fails thrown executions, blocks descendants, and continues unrelated work", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const called: string[] = [];
  const executor: TaskExecutor = async (input) => {
    called.push(input.taskId);
    if (input.taskId === "bad")
      throw new Error("provider secret must not persist");
    return { output: nodeOutput(`Completed ${input.taskId}`) };
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [{ id: "bad" }, { id: "child", needs: ["bad"] }, { id: "good" }],
      concurrency: 2,
    },
    workingDirectory: stateRoot,
    executor,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(new Set(called), new Set(["bad", "good"]));
  assert.deepEqual(statuses(result), {
    bad: "failed",
    child: "blocked",
    good: "succeeded",
  });
  const failed = await readNodeOutput(stateRoot, result.runId, "bad");
  assert.equal(failed.diagnostics, "Task executor failed");
  assert.equal(JSON.stringify(failed).includes("provider secret"), false);
});

test("treats reported blockers as failure and retains the report", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const called: string[] = [];
  const executor: TaskExecutor = async (input) => {
    called.push(input.taskId);
    return {
      output:
        input.taskId === "blocked-root"
          ? { ...nodeOutput("Could not finish"), blockers: ["Missing API"] }
          : nodeOutput(`Completed ${input.taskId}`),
    };
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [
        { id: "blocked-root" },
        { id: "child", needs: ["blocked-root"] },
        { id: "unrelated" },
      ],
      concurrency: 2,
    },
    workingDirectory: stateRoot,
    executor,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(new Set(called), new Set(["blocked-root", "unrelated"]));
  assert.deepEqual(statuses(result), {
    "blocked-root": "failed",
    child: "blocked",
    unrelated: "succeeded",
  });
  const output = await readNodeOutput(stateRoot, result.runId, "blocked-root");
  assert.equal(output.status, "failed");
  assert.deepEqual(output.output?.blockers, ["Missing API"]);
});

test("aborts running and pending work while blocking descendants", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const controller = new AbortController();
  const called: string[] = [];
  let executorObservedAbort = false;
  const executor: TaskExecutor = (input) => {
    called.push(input.taskId);
    queueMicrotask(() => controller.abort());
    return new Promise((resolveExecution) => {
      input.signal.addEventListener(
        "abort",
        () => {
          executorObservedAbort = true;
          resolveExecution({ output: nodeOutput("Ignored") });
        },
        { once: true },
      );
    });
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [
        { id: "first" },
        { id: "second" },
        { id: "child", needs: ["first"] },
      ],
      concurrency: 1,
    },
    workingDirectory: stateRoot,
    executor,
    signal: controller.signal,
  });

  assert.equal(result.status, "aborted");
  assert.deepEqual(called, ["first"]);
  assert.equal(executorObservedAbort, true);
  assert.deepEqual(statuses(result), {
    first: "aborted",
    second: "aborted",
    child: "blocked",
  });
});

test("bounds task runtime and aborts the executor signal on timeout", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let observedAbort = false;
  const executor: TaskExecutor = (input) =>
    new Promise((resolveExecution) => {
      input.signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          resolveExecution({ output: nodeOutput("Stopped") });
        },
        { once: true },
      );
    });

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [{ id: "task" }, { id: "child", needs: ["task"] }],
    },
    workingDirectory: stateRoot,
    executor,
    taskTimeoutMs: 20,
  });

  assert.equal(observedAbort, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(statuses(result), {
    task: "failed",
    child: "blocked",
  });
  assert.equal(
    (await readNodeOutput(stateRoot, result.runId, "task")).diagnostics,
    "Task executor timed out",
  );
});

test("aborts other executors when runner persistence fails", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let started = 0;
  let releaseStarted: () => void = () => {};
  const bothStarted = new Promise<void>((resolveStarted) => {
    releaseStarted = resolveStarted;
  });
  let siblingObservedAbort = false;
  const executor: TaskExecutor = async (input) => {
    started += 1;
    if (started === 2) releaseStarted();
    await bothStarted;
    if (input.taskId === "breaker") {
      await rm(join(stateRoot, "runs", input.runId), {
        recursive: true,
        force: true,
      });
      return { output: nodeOutput("Removed run state") };
    }
    return new Promise((resolveExecution) => {
      if (input.signal.aborted) {
        siblingObservedAbort = true;
        resolveExecution({ output: nodeOutput("Stopped") });
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => {
          siblingObservedAbort = true;
          resolveExecution({ output: nodeOutput("Stopped") });
        },
        { once: true },
      );
    });
  };

  await assert.rejects(() =>
    runGraph({
      stateRoot,
      graph: { tasks: [{ id: "breaker" }, { id: "sibling" }], concurrency: 2 },
      workingDirectory: stateRoot,
      executor,
      taskTimeoutMs: 5_000,
    }),
  );
  assert.equal(siblingObservedAbort, true);
});

test("rejects structurally invalid graphs before creating a run", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let calls = 0;
  const executor: TaskExecutor = async () => {
    calls += 1;
    return { output: nodeOutput() };
  };
  const invalidGraphs: readonly GraphRequest[] = [
    { tasks: [{ id: "same" }, { id: "same" }] },
    { tasks: [{ id: "task", needs: ["missing"] }] },
    { tasks: [{ id: "task", needs: ["task"] }] },
    {
      tasks: [
        { id: "a", needs: ["b"] },
        { id: "b", needs: ["a"] },
      ],
    },
    { tasks: [], concurrency: 0 },
  ];

  for (const graph of invalidGraphs) {
    await assert.rejects(
      () =>
        runGraph({
          stateRoot,
          graph,
          workingDirectory: stateRoot,
          executor,
        }),
      GraphValidationError,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(() => stat(join(stateRoot, "runs")));
});

test("rejects runtime bounds before creating a run or calling the executor", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let calls = 0;
  const executor: TaskExecutor = async () => {
    calls += 1;
    return { output: nodeOutput() };
  };
  const roots = Array.from(
    { length: RUN_GRAPH_LIMITS.maxDependenciesPerTask + 1 },
    (_, index) => ({ id: `root-${index}` }),
  );
  const oversizedPayload = "x".repeat(RUN_GRAPH_LIMITS.maxPayloadBytes + 1);
  let deepPayload: unknown = "leaf";
  for (let depth = 0; depth < 110; depth += 1) deepPayload = [deepPayload];
  const cases = [
    {
      tasks: Array.from(
        { length: RUN_GRAPH_LIMITS.maxTasks + 1 },
        (_, index) => ({ id: `task-${index}` }),
      ),
    },
    {
      tasks: [{ id: "task" }],
      concurrency: RUN_GRAPH_LIMITS.maxConcurrency + 1,
    },
    {
      tasks: [...roots, { id: "join", needs: roots.map((task) => task.id) }],
    },
    {
      tasks: [{ id: "task", payload: oversizedPayload }],
    },
    {
      tasks: [{ id: "task", payload: deepPayload }],
    },
  ];

  for (const graph of cases) {
    await assert.rejects(
      () =>
        runGraph({
          stateRoot,
          graph,
          workingDirectory: stateRoot,
          executor,
        }),
      RunGraphValidationError,
    );
  }
  await assert.rejects(
    () =>
      runGraph({
        stateRoot,
        graph: { tasks: [{ id: "task", payload: new Date() }] },
        workingDirectory: stateRoot,
        executor,
      }),
    RunGraphValidationError,
  );
  await assert.rejects(
    () =>
      runGraph({
        stateRoot,
        graph: { tasks: [] },
        workingDirectory: " ",
        executor,
      }),
    RunGraphValidationError,
  );
  for (const taskTimeoutMs of [0, RUN_GRAPH_LIMITS.maxTaskRuntimeMs + 1]) {
    await assert.rejects(
      () =>
        runGraph({
          stateRoot,
          graph: { tasks: [] },
          workingDirectory: stateRoot,
          executor,
          taskTimeoutMs,
        }),
      RunGraphValidationError,
    );
  }

  assert.equal(calls, 0);
  await assert.rejects(() => stat(join(stateRoot, "runs")));
});

test("turns oversized executor output into a bounded node failure", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const called: string[] = [];
  const executor: TaskExecutor = async (input) => {
    called.push(input.taskId);
    return {
      output: {
        ...nodeOutput(),
        summary: "x".repeat(RUN_GRAPH_LIMITS.maxOutputBytes),
      },
    } as TaskExecutionResult;
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [{ id: "root" }, { id: "child", needs: ["root"] }],
    },
    workingDirectory: stateRoot,
    executor,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(called, ["root"]);
  assert.deepEqual(statuses(result), {
    root: "failed",
    child: "blocked",
  });
  assert.equal(
    (await readNodeOutput(stateRoot, result.runId, "root")).diagnostics,
    "Task executor returned an invalid or oversized result",
  );
});

test("turns hostile and malformed executor results into bounded failures", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const throwingResult = Object.defineProperty({}, "output", {
    enumerable: true,
    get() {
      throw new Error("getter secret must not escape");
    },
  });
  const customSerialization = Object.defineProperty({}, "toJSON", {
    enumerable: false,
    value() {
      throw new Error("serialization secret must not escape");
    },
  });
  let deepOutput: unknown = "leaf";
  for (let depth = 0; depth < 110; depth += 1) deepOutput = [deepOutput];
  const { blockers: _blockers, ...incompleteReport } = nodeOutput();
  const malformed = new Map<string, unknown>([
    ["array", []],
    ["custom-serialization", customSerialization],
    ["deep", { output: deepOutput }],
    ["getter", throwingResult],
    ["incomplete-report", { output: incompleteReport }],
    [
      "invalid-report-section",
      { output: { ...nodeOutput(), validation: ["npm test"] } },
    ],
    ["missing-output", {}],
    ["null", null],
    ["number", 1],
    [
      "oversized-diagnostics",
      {
        output: nodeOutput(),
        diagnostics: "x".repeat(NODE_OUTPUT_LIMITS.maxDiagnosticsBytes + 1),
      },
    ],
    ["string", "ok"],
    [
      "undeclared-report-field",
      { output: { ...nodeOutput(), transcript: "must not propagate" } },
    ],
    ["unknown-envelope-field", { summary: "not the result envelope" }],
  ]);
  const executor: TaskExecutor = async (input) =>
    malformed.get(input.taskId) as TaskExecutionResult;

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [...malformed.keys()].map((id) => ({ id })),
      concurrency: 4,
    },
    workingDirectory: stateRoot,
    executor,
  });

  assert.equal(result.status, "failed");
  assert.ok(result.nodes.every((node) => node.status === "failed"));
  for (const taskId of malformed.keys()) {
    const output = await readNodeOutput(stateRoot, result.runId, taskId);
    assert.equal(
      output.diagnostics,
      "Task executor returned an invalid or oversized result",
    );
    assert.equal(JSON.stringify(output).includes("getter secret"), false);
  }
});

test("fails a task instead of passing oversized prerequisite context", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  const called: string[] = [];
  const largeReport = (taskId: string): NodeOutput => {
    const text = `${taskId}:${"x".repeat(15 * 1024)}`;
    return {
      ...nodeOutput(text),
      changedFiles: [{ path: `${taskId}.ts`, description: text }],
      interfaces: [text],
      decisions: [text],
      validation: [{ command: text, result: text }],
      blockers: [],
    };
  };
  const executor: TaskExecutor = async (input) => {
    called.push(input.taskId);
    return { output: largeReport(input.taskId) };
  };

  const result = await runGraph({
    stateRoot,
    graph: {
      tasks: [
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "join", needs: ["a", "b", "c"] },
      ],
      concurrency: 3,
    },
    workingDirectory: stateRoot,
    executor,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(new Set(called), new Set(["a", "b", "c"]));
  assert.equal(statuses(result).join, "failed");
  assert.equal(
    (await readNodeOutput(stateRoot, result.runId, "join")).diagnostics,
    "Serialized direct-prerequisite context exceeds limit",
  );
});

test("completes an empty graph without invoking the executor", async (t) => {
  const stateRoot = await temporaryStateRoot(t);
  let called = false;

  const result = await runGraph({
    stateRoot,
    graph: { tasks: [] },
    workingDirectory: stateRoot,
    executor: async () => {
      called = true;
      return { output: nodeOutput() };
    },
  });

  assert.equal(called, false);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.nodes, []);
});
