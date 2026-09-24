/**
 * Tier 1: did the agent's work resolve the task?
 *
 * The gate is mechanical and binary. Every target in the task's fail-to-pass
 * set passes, and nothing that passed before regresses. What a target is and
 * how one runs belongs to the suite (`bench/suites/<name>/`); the rule that
 * turns target states into a verdict is the same for every suite, so it lives
 * here.
 */

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

/** Exit code of coreutils `timeout` when it had to stop the command. */
const TIMEOUT_EXIT = 124;

/**
 * A target that is a shell command, passing exactly when it exits 0.
 *
 * Bounded inside the container with `timeout`, not only by the exec: killing
 * `docker exec` on the host leaves the command running in the container, and a
 * solution that loops forever would then outlive its own grade.
 */
export async function runCommandTarget(
  container,
  command,
  { timeoutS = 300 } = {},
) {
  const result = await container.exec(`timeout ${timeoutS} ${command}`, {
    timeoutMs: (timeoutS + 60) * 1000,
  });
  const timedOut = result.timedOut || result.code === TIMEOUT_EXIT;
  return {
    state: !timedOut && result.code === 0 ? "pass" : "fail",
    reason: timedOut
      ? "timeout"
      : result.code === 0
        ? "passed"
        : `exit ${result.code}`,
    tail: result.stdout.slice(-600),
    ...(result.stderr ? { errorTail: result.stderr.slice(-1200) } : {}),
  };
}
