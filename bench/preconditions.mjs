/**
 * Was the treatment actually administered?
 *
 * The treatment is work delegated to the arm's workers under an acceptance
 * the parent did not have to supply itself: a review or a check. A `graph`
 * cell whose parent never delegated, or accepted every node on a worker's say
 * alone, is not evidence about that, and must not be scored as though it were.
 *
 * Fan-out is recorded, not required. The first bench suite's central failure
 * was scoring one-task graphs as if they were fan-out -- the orchestrator put
 * eight independent files into a single worker, and the measured 3.9x cost was
 * the price of one extra subprocess hop with no parallelism at all. The claim
 * under test is cost at the same quality, which parallelism is no part of, so
 * `graphSizes` is reported beside every cell for that reading instead.
 *
 * Failing a precondition is a finding about the prompt surface, reported with
 * its count and its reason. It is not a loss, and it is not silently dropped.
 */
import { armConfig } from "./arms.mjs";

const TOOL = "worker_graph";

/**
 * The task counts of every graph the parent requested, from the tool's own
 * arguments. Returns null when the stream carried no arguments at all, which
 * has to stay distinguishable from "it requested a one-task graph".
 */
export function graphSizes(events) {
  const starts = events.filter(
    (e) => e.type === "tool_execution_start" && e.toolName === TOOL,
  );
  if (starts.length === 0) return [];
  const sizes = starts.map((e) =>
    Array.isArray(e.args?.tasks) ? e.args.tasks.length : null,
  );
  return sizes.every((s) => s === null) ? null : sizes;
}

/**
 * How many requested nodes carried a review policy or a check. Null for the
 * same reason.
 */
export function acceptedNodeCount(events) {
  const starts = events.filter(
    (e) => e.type === "tool_execution_start" && e.toolName === TOOL,
  );
  if (starts.length === 0) return 0;
  if (starts.every((e) => !Array.isArray(e.args?.tasks))) return null;
  return starts
    .flatMap((e) => (Array.isArray(e.args?.tasks) ? e.args.tasks : []))
    .filter((task) => task?.review !== undefined || task?.check !== undefined)
    .length;
}

export function evaluatePreconditions({ arm, events = [], toolCalls = [] }) {
  const called = toolCalls.filter((c) => c.toolName === TOOL).length;
  const sizes = graphSizes(events);
  const accepted = acceptedNodeCount(events);
  const failed = [];

  if (!armConfig(arm).machinery) {
    // A solo arm has no treatment to administer, but the tool must not have
    // been reachable. If it was, the arms are not what they claim to be.
    if (called > 0) failed.push("worker_graph reachable in a solo arm");
    return {
      met: failed.length === 0,
      failed,
      calls: called,
      graphSizes: sizes,
      acceptedNodes: accepted,
    };
  }

  if (called === 0) failed.push("worker_graph never called");
  // Unknown is never met. A stream that did not carry the tool's arguments
  // cannot show any node was accepted on more than its worker's report, and
  // treating that as satisfied is exactly the mistake this file exists to
  // prevent.
  if (accepted === null) failed.push("graph requests unknown");
  else if (called > 0 && accepted === 0)
    failed.push("no node carried a review or a check");

  return {
    met: failed.length === 0,
    failed,
    calls: called,
    graphSizes: sizes,
    acceptedNodes: accepted,
  };
}

/**
 * A loop arm's treatment is its checked node, run with no parent: met when a
 * worker ran under the check at least once. Each attempt is a one-node graph
 * whose node carried a check, so the graph fields read as they would for a
 * `graph` arm that planned the same.
 */
export function loopPreconditions(loop) {
  const ran = loop.attempts.filter(
    (attempt) => (attempt.rounds ?? []).length > 0,
  ).length;
  const failed = ran === 0 ? ["no worker ran"] : [];
  return {
    met: failed.length === 0,
    failed,
    calls: loop.attempts.length,
    graphSizes: loop.attempts.map(() => 1),
    acceptedNodes: loop.attempts.length,
  };
}
