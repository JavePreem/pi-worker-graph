/**
 * The task suites a bench store can be drawn from.
 *
 * A suite is a module exporting:
 *
 *   name                     the id a manifest records
 *   preamble                 what every arm is told before each task's prompt
 *   revision?                what else fixes the task text, for the fingerprint
 *   loadTasks(options)       { tasks, dropped, trialOnly }; a task is
 *                            { id, image, prompt, ...whatever grade needs }
 *   grade(container, task)   the Tier 1 verdict (`bench/grade.mjs`)
 *   ensureImage?(image)      how the image reaches the host; pull by default
 *   prepare?(container, t)   puts the task's checkout in place at TESTBED
 *   applyReference?(c, t)    a known-good solution, for the grading self-test
 *
 * Everything else -- containers, confinement, the agent, the queue, the
 * analysis -- is shared, so two suites differ only in what is asked and how it
 * is checked.
 */
const SUITES = {
  coldstart: () => import("./coldstart/suite.mjs"),
  polyglot: () => import("./polyglot/suite.mjs"),
  promax: () => import("./promax/suite.mjs"),
};

export function suiteNames() {
  return Object.keys(SUITES);
}

export async function loadSuite(name) {
  const load = SUITES[name];
  if (load === undefined)
    throw new Error(
      `unknown suite: ${name}; one of ${suiteNames().join(", ")}`,
    );
  return load();
}
