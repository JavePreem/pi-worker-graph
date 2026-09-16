/**
 * Was the treatment actually administered?
 *
 * The first bench suite's central failure was scoring one-task graphs as if
 * they were fan-out: the orchestrator put eight independent files into a single
 * worker, and the measured 3.9x cost was the price of one extra subprocess hop
 * with no parallelism at all. A `graph` cell that never fanned out is not
 * evidence about delegation, and must not be scored as though it were.
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

/** How many requested nodes carried a review policy. Null for the same reason. */
export function reviewedNodeCount(events) {
  const starts = events.filter(
    (e) => e.type === "tool_execution_start" && e.toolName === TOOL,
  );
  if (starts.length === 0) return 0;
  if (starts.every((e) => !Array.isArray(e.args?.tasks))) return null;
  return starts
    .flatMap((e) => (Array.isArray(e.args?.tasks) ? e.args.tasks : []))
    .filter((task) => task?.review !== undefined).length;
}

export function evaluatePreconditions({ arm, events = [], toolCalls = [] }) {
  const called = toolCalls.filter((c) => c.toolName === TOOL).length;
  const sizes = graphSizes(events);
  const reviewed = reviewedNodeCount(events);
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
      reviewedNodes: reviewed,
    };
  }

  if (called === 0) failed.push("worker_graph never called");
  // Unknown is never met. A stream that did not carry the tool's arguments
  // cannot show fan-out happened, and treating that as satisfied is exactly
  // the mistake this file exists to prevent.
  if (sizes === null) failed.push("graph sizes unknown");
  else if (called > 0 && !sizes.some((size) => size > 1))
    failed.push("no graph had more than one task");
  if (reviewed === null) failed.push("review policies unknown");
  else if (called > 0 && reviewed === 0)
    failed.push("no node carried a review policy");

  return {
    met: failed.length === 0,
    failed,
    calls: called,
    graphSizes: sizes,
    reviewedNodes: reviewed,
  };
}
