/**
 * The ProMax suite: the TypeScript subset of SWE-Bench ProMax, graded by the
 * Bazel targets `validate-instances.py` recorded for each instance.
 *
 * Every image is a built checkout at `/testbed` with a warm Bazel cache. The
 * task is the image, its problem statement, and its tests: `prepare` commits
 * `test_patch` before the agent starts. Hidden tests were tried first and
 * graded guessing -- on `c_b8f2a50` both models put a new constructor
 * parameter last, the statement never says where, and the hidden spec passes
 * it positionally in the middle. See DESIGN.md "Why not hidden".
 */
import { applyPatch, TESTBED } from "../../container.mjs";
import { gradeableInstances, loadInstances } from "./dataset.mjs";
import { gradeTier1 } from "./grade.mjs";

export const name = "promax";

/**
 * What every arm is told, on top of the instance's own problem statement.
 *
 * It exists because the first live cells failed on the harness rather than on
 * the task: agents shipped edits that never compiled, and could not tell which
 * tests would judge them. Neither is a fact about the model; both are facts
 * about an agent given a bug report and nothing else.
 *
 * It is a harness constant. Every arm gets the same bytes, it says nothing
 * about decomposition, delegation or worker counts -- that is arm
 * configuration and open decision 4 -- and it names nothing instance-specific.
 * Its hash goes in the manifest, so two runs under different wording cannot be
 * pooled by accident.
 *
 * Bazel is named outright because the pool is one repository. A second
 * repository in a top-up pool would have to make this per-repo rather than
 * teach every agent a build system its instance does not use.
 */
export const preamble = `You are working in a checkout of this repository at ${TESTBED}.

How the work is judged:
- The tests that grade your change are already in the checkout, committed
  at HEAD, and the Bazel targets that run them are listed after the task.
  The task is resolved when every listed target passes.
- Before grading, every file those tests touch is put back to HEAD, so any
  change you make to them is discarded.
- Your change must compile. An edit that does not build scores the same as no
  edit at all.

Building and testing:
- Bazel is the build system: ./node_modules/.bin/bazelisk test <target> runs a
  test target, and ./node_modules/.bin/bazelisk build <target> builds one.
- It is slow -- expect minutes for a target, not seconds -- so build the
  narrowest target that covers your change rather than the whole repository.
- Verify before you finish. Reporting an unverified change is worse than
  reporting that you ran out of time with the change described.

The task follows.

`;

const task = (instance) => ({
  id: instance.id,
  image: instance.row.image_name,
  prompt:
    `${instance.row.problem_statement}\n\nGraded targets:\n` +
    [...instance.targets, ...instance.regressionTargets]
      .map((t) => `- ${t}`)
      .join("\n"),
  targets: instance.targets,
  regressionTargets: instance.regressionTargets,
  testPatch: instance.row.test_patch,
  goldPatch: instance.row.patch,
  ...(instance.excludedFor === undefined
    ? {}
    : { excludedFor: instance.excludedFor }),
});

/**
 * The drawable pool, what was dropped from it and why, and the excluded
 * instances a trial may still name.
 *
 * The permutation is drawn once and cannot be extended, so a pool that is
 * still being validated would silently become the whole experiment. Finish
 * the sweep, or say explicitly that the smaller pool is the intent.
 */
export async function loadTasks({ partialPool = false } = {}) {
  const { gradeable, dropped, excludedGradeable } = await gradeableInstances();
  const instances = await loadInstances();
  const subset = [...instances.values()].filter(
    (row) =>
      row.language.toLowerCase() ===
      (process.env.BENCH_LANGUAGE ?? "typescript"),
  );
  // Counted by id rather than by subtracting lengths: an exclusion or a record
  // for an instance outside the subset would otherwise cancel out a genuinely
  // unvalidated one and the pool would be drawn short without saying so.
  const accounted = new Set([
    ...gradeable.map((i) => i.id),
    ...dropped.map((d) => d.id),
  ]);
  const unvalidated = subset
    .map((row) => row.instance_id)
    .filter((id) => !accounted.has(id));
  if (unvalidated.length > 0 && !partialPool) {
    throw new Error(
      `${unvalidated.length} of ${subset.length} instances are not validated ` +
        `yet: ${unvalidated.join(", ")}. The task order is drawn once and ` +
        "cannot be extended: finish validate-instances.py, or pass " +
        "--partial-pool to fix the order over the smaller pool deliberately.",
    );
  }
  return {
    tasks: gradeable.map(task),
    dropped,
    trialOnly: excludedGradeable.map(task),
  };
}

/**
 * Commit the tests over the image's checkout, so they are visible to the agent,
 * its diff is only its own work, and grading has a commit to restore them from.
 */
export async function prepare(container, t) {
  const file = "/tmp/test_patch.diff";
  await container.write(file, t.testPatch);
  // The images' index carries stale stat data, which `--index` reads as a
  // mismatch; the refresh rewrites only the cached stat.
  const result = await container.exec(
    `cd ${TESTBED} && git update-index -q --refresh; ` +
      `git apply --index ${file} && ` +
      "git -c user.name=bench -c user.email=bench@invalid commit -q --no-verify -m tests",
    { timeoutMs: 300_000 },
  );
  if (result.code !== 0) {
    throw new Error(`committing test_patch: ${result.stderr.slice(-400)}`);
  }
}

/** A task carries `testPatch`, `targets` and `regressionTargets` by name. */
export { gradeTier1 as grade };

/** The gold patch, standing in for the agent in the grading self-test. */
export function applyReference(container, t) {
  return applyPatch(container, t.goldPatch, { label: "gold_patch" });
}
