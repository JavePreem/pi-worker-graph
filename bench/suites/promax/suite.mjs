/**
 * The ProMax suite: the TypeScript subset of SWE-Bench ProMax, graded by the
 * Bazel targets `validate-instances.py` recorded for each instance.
 *
 * Every image is a built checkout at `/testbed` with a warm Bazel cache, so
 * there is no `prepare` step: the task is the image plus its problem statement.
 */
import { applyPatch, TESTBED } from "../../container.mjs";
import { gradeableInstances, loadInstances } from "./dataset.mjs";
import { gradeTier1 } from "./grade.mjs";

export const name = "promax";

/**
 * What every arm is told, on top of the instance's own problem statement.
 *
 * It exists because the first live cells failed on the harness rather than on
 * the task: one agent edited a file the graded test patch touches, which voids
 * the grade before a target runs, and another shipped an edit that never
 * compiled. Neither is a fact about the model; both are facts about an agent
 * given a bug report and nothing else.
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
- Your change is graded by tests that are applied to the checkout after you
  finish. Do not create, edit or delete any existing test file: a test file you
  have touched makes the graded patch fail to apply, and the task is scored
  unresolved whatever your fix was worth.
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
  prompt: instance.row.problem_statement,
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

/** A task carries `testPatch`, `targets` and `regressionTargets` by name. */
export { gradeTier1 as grade };

/** The gold patch, standing in for the agent in the grading self-test. */
export function applyReference(container, t) {
  return applyPatch(container, t.goldPatch, { label: "gold_patch" });
}
