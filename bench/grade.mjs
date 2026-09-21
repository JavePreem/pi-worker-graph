/**
 * Tier 1: did the agent's work resolve the instance?
 *
 * The gate is mechanical and binary. Every target in the instance's recorded
 * fail-to-pass set passes, and nothing that passed before regresses. The
 * target set is read from `validate-results.json`, not derived here -- see
 * DESIGN.md "Grading".
 *
 * The agent must never see the tests, so `test_patch` is applied only at grade
 * time, after the agent has finished.
 */
import { applyPatch, TESTBED } from "./container.mjs";

// Bazel's documented exit codes. 4 is the one that matters most here: it means
// no test ran at all, which a text scraper reads as "nothing failed" and would
// score as a pass.
const BAZEL = {
  SUCCESS: 0,
  BUILD_FAILED: 1,
  TESTS_FAILED: 3,
  NO_TESTS_FOUND: 4,
};

/**
 * One target's outcome, from the exit code. The summary text is kept for the
 * record and never decides anything.
 */
export function classifyTargetRun({
  code,
  stdout = "",
  stderr = "",
  timedOut = false,
}) {
  const executed = /Executed (\d+) out of (\d+) test/.exec(stdout)?.[0] ?? null;
  if (timedOut) return { state: "fail", reason: "timeout", executed };
  switch (code) {
    case BAZEL.SUCCESS:
      return { state: "pass", reason: "passed", executed };
    case BAZEL.TESTS_FAILED:
      return { state: "fail", reason: "tests failed", executed };
    case BAZEL.BUILD_FAILED:
      return { state: "fail", reason: "build failed", executed };
    case BAZEL.NO_TESTS_FOUND:
      // Not a pass. A target that runs no test cannot show the fix landed, and
      // reading it as success is how a grading harness silently inflates a
      // resolve rate.
      return { state: "fail", reason: "no test ran", executed };
    default:
      return {
        state: "fail",
        reason: `bazel exit ${code}`,
        executed,
        detail: stderr.slice(-300),
      };
  }
}

/**
 * The gate itself, over already-classified target states. Pure, so the rule
 * that decides every cell is testable without a container.
 */
export function resolveTier1({ targets, regressionTargets = [], states }) {
  const missing = [...targets, ...regressionTargets].filter(
    (t) => !(t in states),
  );
  if (missing.length > 0) {
    return {
      resolved: false,
      outcome: "harness",
      detail: `ungraded targets: ${missing.join(", ")}`,
    };
  }
  const failed = targets.filter((t) => states[t].state !== "pass");
  const regressed = regressionTargets.filter(
    (t) => !targets.includes(t) && states[t].state !== "pass",
  );
  if (regressed.length > 0) {
    return { resolved: false, outcome: "regressed", regressed, failed };
  }
  if (failed.length > 0)
    return { resolved: false, outcome: "unresolved", failed };
  return { resolved: true, outcome: "resolved" };
}

/** Run one Bazel target with test caching off. */
export async function runTarget(
  container,
  target,
  { timeoutMs = 1_800_000 } = {},
) {
  const result = await container.exec(
    `cd ${TESTBED} && ./node_modules/.bin/bazelisk test ${target}` +
      " --nocache_test_results --jobs=3 --local_ram_resources=3072 --test_output=summary",
    { timeoutMs },
  );
  // Both streams, because they answer different questions. Bazel's summary is
  // on stdout; the compiler diagnostic that explains `build failed` is on
  // stderr, and keeping only stdout left a failed cell unable to say what did
  // not compile -- which is the difference between a model that could not do
  // the task and one that never built its own edit.
  return {
    ...classifyTargetRun(result),
    tail: result.stdout.slice(-600),
    ...(result.stderr ? { errorTail: result.stderr.slice(-1200) } : {}),
  };
}

/**
 * Grade a finished checkout. The caller has already run the agent (or applied
 * the gold patch, for the self-test) and the container still holds its work.
 */
export async function gradeTier1(
  container,
  { testPatch, targets, regressionTargets = [] },
) {
  const applied = await applyPatch(container, testPatch, {
    label: "test_patch",
  });
  if (!applied.applied) {
    // The tests are supposed to apply cleanly onto whatever the agent left. A
    // conflict means the agent changed a file the test patch touches, which is
    // the one thing it was told not to do, and it is an outcome rather than a
    // harness failure.
    return {
      resolved: false,
      outcome: "test-patch-conflict",
      detail: applied.detail,
      // Named, so the claim "the agent edited the tests" can be checked
      // against the diff instead of taken on the outcome's word.
      conflicted: applied.conflicted ?? [],
      states: {},
    };
  }
  const states = {};
  for (const target of new Set([...targets, ...regressionTargets])) {
    states[target] = await runTarget(container, target);
  }
  return { ...resolveTier1({ targets, regressionTargets, states }), states };
}
