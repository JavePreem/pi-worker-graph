/**
 * ProMax Tier 1: Bazel targets over the instance's recorded fail-to-pass set.
 *
 * The gate is `resolveTier1` (`bench/grade.mjs`). The target set is read from
 * `validate-results.json`, not derived here -- see DESIGN.md "Grading".
 *
 * The tests are visible: `prepare` (`suite.mjs`) commits `test_patch` into the
 * checkout before the agent starts, and grading puts those files back to that
 * commit, so what is graded is the tests as shipped, whatever the agent did to
 * them.
 */
import { TESTBED } from "../../container.mjs";
import { resolveTier1 } from "../../grade.mjs";

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

/** Every path a diff touches, on either side, `/dev/null` excluded. */
export function patchPaths(diff) {
  const paths = new Set();
  for (const m of diff.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) {
    paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Put every file the test patch touches back to HEAD, where `prepare`
 * committed them; one the agent created where the patch deletes is removed.
 * SWE-bench grades the same way. The agent may edit a shared test helper to
 * keep its own build compiling -- `c_b8f2a50` needed that -- and the edit is
 * discarded rather than voiding the grade.
 */
async function restoreTestFiles(container, testPatch) {
  const script = patchPaths(testPatch)
    .map((p) => {
      const q = JSON.stringify(p);
      return `if git cat-file -e HEAD:${q} 2>/dev/null; then git checkout HEAD -- ${q}; else rm -f -- ${q}; fi`;
    })
    .join(" && ");
  if (script === "") return;
  const result = await container.exec(`cd ${TESTBED} && ${script}`);
  if (result.code !== 0) {
    throw new Error(`restoring test files: ${result.stderr.slice(-400)}`);
  }
}

/**
 * Grade a finished checkout. The caller has already run the agent (or applied
 * the gold patch, for the self-test) and the container still holds its work.
 */
export async function gradeTier1(
  container,
  { testPatch, targets, regressionTargets = [] },
) {
  await restoreTestFiles(container, testPatch);
  const states = {};
  for (const target of new Set([...targets, ...regressionTargets])) {
    states[target] = await runTarget(container, target);
  }
  return { ...resolveTier1({ targets, regressionTargets, states }), states };
}
