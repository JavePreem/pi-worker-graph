import assert from "node:assert/strict";
import test from "node:test";
import type { GraphRequest, GraphState, NodeStatus } from "../src/index.js";
import {
  createInitialState,
  GraphValidationError,
  isGraphComplete,
  normalizeGraph,
  readyFrontier,
  setNodeStatus,
  settleBlocked,
  validateGraph,
} from "../src/index.js";

function graph(tasks: GraphRequest["tasks"], concurrency?: number) {
  return normalizeGraph({
    tasks,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

function statuses(state: GraphState): Record<string, NodeStatus> {
  return Object.fromEntries(state);
}

test("accepts an empty graph", () => {
  const normalized = graph([]);
  const state = createInitialState(normalized);

  assert.deepEqual(readyFrontier(normalized, state), []);
  assert.equal(isGraphComplete(normalized, state), true);
});

test("makes a single task ready", () => {
  const normalized = graph([{ id: "only" }]);

  assert.deepEqual(readyFrontier(normalized, createInitialState(normalized)), [
    "only",
  ]);
});

test("sorts a flat ready frontier deterministically", () => {
  const normalized = graph([{ id: "z" }, { id: "a" }, { id: "middle" }]);

  assert.deepEqual(readyFrontier(normalized, createInitialState(normalized)), [
    "a",
    "middle",
    "z",
  ]);
});

test("advances through a chain", () => {
  const normalized = graph([
    { id: "build" },
    { id: "test", needs: ["build"] },
    { id: "publish", needs: ["test"] },
  ]);
  let state = createInitialState(normalized);

  assert.deepEqual(readyFrontier(normalized, state), ["build"]);
  state = setNodeStatus(normalized, state, "build", "running");
  state = setNodeStatus(normalized, state, "build", "succeeded");
  assert.deepEqual(readyFrontier(normalized, state), ["test"]);
  state = setNodeStatus(normalized, state, "test", "running");
  state = setNodeStatus(normalized, state, "test", "succeeded");
  assert.deepEqual(readyFrontier(normalized, state), ["publish"]);
});

test("handles a diamond graph", () => {
  const normalized = graph([
    { id: "root" },
    { id: "left", needs: ["root"] },
    { id: "right", needs: ["root"] },
    { id: "join", needs: ["right", "left"] },
  ]);
  let state = createInitialState(normalized);

  state = setNodeStatus(normalized, state, "root", "running");
  state = setNodeStatus(normalized, state, "root", "succeeded");
  assert.deepEqual(readyFrontier(normalized, state), ["left", "right"]);

  state = setNodeStatus(normalized, state, "left", "running");
  state = setNodeStatus(normalized, state, "left", "succeeded");
  assert.deepEqual(readyFrontier(normalized, state), ["right"]);

  state = setNodeStatus(normalized, state, "right", "running");
  state = setNodeStatus(normalized, state, "right", "succeeded");
  assert.deepEqual(readyFrontier(normalized, state), ["join"]);
});

test("normalizes IDs and dependencies without mutating input", () => {
  const request = {
    tasks: [
      { id: " root ", payload: { value: 1 } },
      { id: " child ", needs: [" root ", "root", " root "] },
    ],
    concurrency: 2,
  } satisfies GraphRequest<{ value: number }>;
  const original = structuredClone(request);

  const normalized = normalizeGraph(request);

  assert.deepEqual(request, original);
  assert.deepEqual(
    normalized.tasks.map((task) => ({ id: task.id, needs: task.needs })),
    [
      { id: "root", needs: [] },
      { id: "child", needs: ["root"] },
    ],
  );
  assert.equal(normalized.concurrency, 2);
});

test("reports structural validation issues", () => {
  const issues = validateGraph({
    tasks: [
      { id: " " },
      { id: "same" },
      { id: " same " },
      { id: "self", needs: ["self"] },
      { id: "missing", needs: ["unknown", " "] },
    ],
    concurrency: 0,
  });

  assert.deepEqual(
    new Set(issues.map((issue) => issue.code)),
    new Set([
      "empty_id",
      "duplicate_id",
      "self_dependency",
      "unknown_dependency",
      "empty_dependency",
      "invalid_concurrency",
    ]),
  );
});

test("handles a deep acyclic graph without recursive traversal", () => {
  const tasks = Array.from({ length: 5_000 }, (_, index) => ({
    id: `task-${index.toString().padStart(4, "0")}`,
    ...(index === 4_999
      ? {}
      : { needs: [`task-${(index + 1).toString().padStart(4, "0")}`] }),
  }));

  assert.deepEqual(validateGraph({ tasks }), []);
});

test("rejects a cycle with a useful path", () => {
  const request = {
    tasks: [
      { id: "a", needs: ["b"] },
      { id: "b", needs: ["c"] },
      { id: "c", needs: ["a"] },
    ],
  } satisfies GraphRequest;

  const issues = validateGraph(request);
  const cycle = issues.find((issue) => issue.code === "cycle");
  assert.ok(cycle?.cycle);
  assert.equal(cycle.cycle[0], cycle.cycle.at(-1));
  assert.throws(() => normalizeGraph(request), GraphValidationError);
});

test("rejects non-positive and non-integer concurrency", () => {
  for (const concurrency of [0, -1, 1.5]) {
    assert.deepEqual(
      validateGraph({ tasks: [], concurrency }).map((issue) => issue.code),
      ["invalid_concurrency"],
    );
  }
});

test("blocks failed descendants while leaving unrelated work ready", () => {
  const normalized = graph([
    { id: "a" },
    { id: "b", needs: ["a"] },
    { id: "c" },
    { id: "d", needs: ["b"] },
  ]);
  let state = createInitialState(normalized);

  state = setNodeStatus(normalized, state, "a", "failed");
  state = settleBlocked(normalized, state);

  assert.deepEqual(statuses(state), {
    a: "failed",
    b: "blocked",
    c: "pending",
    d: "blocked",
  });
  assert.deepEqual(readyFrontier(normalized, state), ["c"]);
});

test("propagates blocking from an aborted prerequisite", () => {
  const normalized = graph([
    { id: "a" },
    { id: "b", needs: ["a"] },
    { id: "c", needs: ["b"] },
  ]);
  let state = createInitialState(normalized);

  state = setNodeStatus(normalized, state, "a", "aborted");
  state = settleBlocked(normalized, state);

  assert.deepEqual(statuses(state), {
    a: "aborted",
    b: "blocked",
    c: "blocked",
  });
  assert.equal(isGraphComplete(normalized, state), true);
});

test("does not expose a join task until every prerequisite succeeds", () => {
  const normalized = graph([
    { id: "left" },
    { id: "right" },
    { id: "join", needs: ["left", "right"] },
  ]);
  let state = createInitialState(normalized);

  state = setNodeStatus(normalized, state, "left", "running");
  state = setNodeStatus(normalized, state, "left", "succeeded");

  assert.deepEqual(readyFrontier(normalized, state), ["right"]);
});

test("returns runtime-read-only state and preserves previous state", () => {
  const normalized = graph([{ id: "task" }]);
  const initial = createInitialState(normalized);
  const running = setNodeStatus(normalized, initial, "task", "running");

  assert.equal(initial.get("task"), "pending");
  assert.equal(running.get("task"), "running");
  assert.notEqual(initial, running);
  assert.equal(Object.isFrozen(initial), true);
  assert.equal("set" in initial, false);
});

test("does not start a task before its prerequisites succeed", () => {
  const normalized = graph([
    { id: "first" },
    { id: "second", needs: ["first"] },
  ]);
  let state = createInitialState(normalized);

  assert.throws(
    () => setNodeStatus(normalized, state, "second", "running"),
    /before all prerequisites succeed/,
  );

  state = setNodeStatus(normalized, state, "first", "failed");
  state = settleBlocked(normalized, state);
  assert.throws(
    () => setNodeStatus(normalized, state, "second", "running"),
    /Invalid task transition/,
  );
});

test("only blocking propagation can mark a task blocked", () => {
  const normalized = graph([{ id: "task" }]);
  const state = createInitialState(normalized);

  assert.throws(
    () => setNodeStatus(normalized, state, "task", "blocked"),
    /Invalid task transition/,
  );
});

test("rejects unknown tasks and invalid terminal transitions", () => {
  const normalized = graph([{ id: "task" }]);
  let state = createInitialState(normalized);

  assert.throws(
    () => setNodeStatus(normalized, state, "unknown", "running"),
    /Unknown task/,
  );

  state = setNodeStatus(normalized, state, "task", "running");
  state = setNodeStatus(normalized, state, "task", "succeeded");
  assert.throws(
    () => setNodeStatus(normalized, state, "task", "failed"),
    /Invalid task transition/,
  );
});
