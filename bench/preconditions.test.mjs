import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedNodeCount,
  evaluatePreconditions,
  graphSizes,
} from "./preconditions.mjs";

const start = (tasks) => ({
  type: "tool_execution_start",
  toolName: "worker_graph",
  args: tasks === undefined ? {} : { tasks },
});
const call = () => ({ toolName: "worker_graph", isError: false, text: "" });

test("a graph arm that never called the tool fails", () => {
  const result = evaluatePreconditions({
    arm: "graph-luna",
    events: [],
    toolCalls: [],
  });
  assert.equal(result.met, false);
  assert.ok(result.failed.includes("worker_graph never called"));
});

test("a one-task graph is recorded, not failed", () => {
  // A parent that repairs through one-node graphs still delegated the work.
  const result = evaluatePreconditions({
    arm: "graph-luna",
    events: [start([{ id: "a", review: {} }]), start([{ id: "b", check: {} }])],
    toolCalls: [call(), call()],
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.met, true);
  assert.deepEqual(result.graphSizes, [1, 1]);
});

test("a node accepted on its check alone administers the treatment", () => {
  const result = evaluatePreconditions({
    arm: "graph-luna",
    events: [start([{ id: "a", check: {} }, { id: "b" }])],
    toolCalls: [call()],
  });
  assert.equal(result.met, true);
  assert.equal(result.acceptedNodes, 1);
});

test("a graph accepted on its workers' reports alone fails", () => {
  const result = evaluatePreconditions({
    arm: "graph-sol",
    events: [start([{ id: "a" }, { id: "b" }])],
    toolCalls: [call()],
  });
  assert.equal(result.met, false);
  assert.ok(result.failed.includes("no node carried a review or a check"));
});

test("arguments the stream never carried are unknown, never satisfied", () => {
  const result = evaluatePreconditions({
    arm: "graph-sol",
    events: [start(undefined)],
    toolCalls: [call()],
  });
  assert.equal(result.met, false);
  assert.ok(result.failed.includes("graph requests unknown"));
  assert.equal(graphSizes([start(undefined)]), null);
  assert.equal(acceptedNodeCount([start(undefined)]), null);
});

test("a solo arm has nothing to administer and passes", () => {
  const result = evaluatePreconditions({
    arm: "solo-sol",
    events: [],
    toolCalls: [],
  });
  assert.equal(result.met, true);
});

test("a solo arm that reached the tool is not the arm it claims to be", () => {
  const result = evaluatePreconditions({
    arm: "solo-sol",
    events: [start([{ id: "a" }, { id: "b" }])],
    toolCalls: [call()],
  });
  assert.equal(result.met, false);
  assert.ok(result.failed.includes("worker_graph reachable in a solo arm"));
});
