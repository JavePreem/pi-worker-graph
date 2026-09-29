/**
 * The four queued arms, the trial-only arms, and the configuration each one
 * hands the agent.
 *
 * They vary two things independently: whether the orchestration machinery is
 * in the loop, and what model does the work. Everything else -- harness,
 * checkout, task text, grading -- is identical, which is the only reason a
 * difference between them can be attributed to either change. See DESIGN.md
 * "Arms".
 */

export const MODELS = {
  sol: "gpt-5.6-sol",
  luna: "gpt-5.6-luna",
};

/**
 * Which provider serves those models is an account fact rather than a design
 * one -- Pi's catalogue offers both through several -- so the harness reads it
 * from the agent directory that holds the credentials, and records it in the
 * manifest. This is only the fallback when nothing else says. The prices the
 * design reasons about are the direct ones, so a provider that marks them up
 * belongs in the disclosure.
 */
export const PROVIDER = process.env.BENCH_PROVIDER;

// Read-only. Model and tools are independent, and keeping the reviewer unable
// to edit is what makes the package mark its profile read-only to the parent,
// so the mechanism and the arm agree about what a reviewer is.
const REVIEWER_TOOLS = ["read", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/**
 * Open decision 2 in DESIGN.md: 2 is the cheap default and whether 3 buys
 * anything is measurable and unmeasured. The harness does not enforce it --
 * the orchestrator chooses a review policy per task -- so this is the ceiling
 * the configuration admits, not an instruction.
 */
export const MAX_REVIEW_ROUNDS = 2;

/**
 * What a refining arm sends after each settled turn. Neutral on purpose: it
 * asks for a second look and says nothing about how to take one, so the arm
 * measures a session kept warm rather than a better prompt.
 */
const REFINE =
  "Refine your work: check it against the task once more and fix anything that falls short.";

/**
 * What the tests-first arm adds to the task, after it. Arm configuration, not
 * package guidance: it is the harness putting words in the orchestrator's
 * mouth, which open decision 4 in DESIGN.md says must be disclosed, and it is
 * written for a cold-start task -- a specification, a public contract, and no
 * tests. It moves into the package only if a cell shows it works.
 *
 * The contract stub is there so the tests-writing task has a check: tests
 * that import a module which does not exist cannot even be collected.
 */
function testsFirst({ reviewTests }) {
  const review = reviewTests
    ? `
  Give that task a review on the reviewer profile, maxRounds 2, with the
  criteria: every rule of the specification's grammar and every function it
  defines has a test, and every test agrees with the specification.`
    : "";
  return `

How to run this task with worker_graph:
- Write the tests first, as one task on the test-author profile: from the
  specification alone, a test suite under tests/ with one file per area of
  the specification, and a stub of the public contract -- every name it lists,
  every function raising NotImplementedError -- and no implementation. Check
  it with \`python3 -m pytest --collect-only -q tests\`, maxRounds 2.${review}
- Then implement against those tests on the worker profile: the structure
  every area shares in one task first, then one task per area behind it. Check
  each with its own area's test files, freeze tests/ and spec/, give it
  maxRounds 4 and no review. The frozen tests are its acceptance.
- Tell implementation workers that a test contradicting the specification is
  a blocker to report, not something to work around. Give its correction to a
  test-author task, then re-run the work it blocked.
- Repair through a task's own check rounds. Plan a new graph only for tasks
  that failed with their rounds spent.
- Finish when \`python3 -m pytest tests\` passes in full.`;
}

export const ARMS = {
  "solo-sol": { machinery: false, parent: MODELS.sol },
  // Trial-only: the queue draws its own arm list (`bench/queue.mjs`), so this
  // runs through `bench.mjs cell` and never enters a store. It is the baseline
  // a graph arm has to beat if its lift is a second look rather than
  // delegation (`docs/NEXT.md` T6).
  "solo-sol-refine": {
    machinery: false,
    parent: MODELS.sol,
    followUps: [REFINE, REFINE],
  },
  "solo-luna": { machinery: false, parent: MODELS.luna },
  "graph-sol": {
    machinery: true,
    parent: MODELS.sol,
    worker: MODELS.sol,
    reviewer: MODELS.sol,
  },
  "graph-luna": {
    machinery: true,
    parent: MODELS.sol,
    worker: MODELS.luna,
    reviewer: MODELS.sol,
  },
  // Trial-only, like `solo-sol-refine`: `graph-luna` with a writable sol
  // profile for the tests and guidance to write them first (`docs/NEXT.md`
  // T2-T4). A reviewer is still configured, so the only additions are the
  // profile and the words.
  "graph-luna-tests-first": {
    machinery: true,
    parent: MODELS.sol,
    worker: MODELS.luna,
    reviewer: MODELS.sol,
    testAuthor: MODELS.sol,
    guidance: testsFirst({ reviewTests: false }),
  },
  // Trial-only: the tests-first arm with one change, a sol review of the tests
  // against the specification. The tests-first cell traced 89 of its 101
  // hidden failures to gaps and errors in the tests (`docs/NEXT.md`).
  "graph-luna-tests-reviewed": {
    machinery: true,
    parent: MODELS.sol,
    worker: MODELS.luna,
    reviewer: MODELS.sol,
    testAuthor: MODELS.sol,
    guidance: testsFirst({ reviewTests: true }),
  },
};

export function armNames() {
  return Object.keys(ARMS);
}

/**
 * Every model an arm needs, deduplicated. A solo arm needs one; a graph arm
 * needs its parent, its workers and its reviewer, which may be two ids or
 * three.
 */
export function armModels(name) {
  const arm = armConfig(name);
  return [
    ...new Set(
      [arm.parent, arm.worker, arm.reviewer, arm.testAuthor].filter(Boolean),
    ),
  ];
}

export function armConfig(name) {
  const arm = ARMS[name];
  if (!arm) throw new Error(`unknown arm: ${name}`);
  return arm;
}

/**
 * The `worker-graph.json` a `graph` arm runs under.
 *
 * A solo arm gets none: the extension has no provider or model defaults, so
 * the absence is what keeps the machinery out of the loop rather than a flag.
 * The orchestrator profile is deliberately omitted -- the harness sets the
 * parent's model when it starts the session, and letting the configuration
 * change it again on `/swarm on` would mean two things setting one model.
 */
export function workerGraphConfig(
  name,
  { provider = PROVIDER, stateRoot, maxGraphCostUsd } = {},
) {
  const arm = armConfig(name);
  if (!arm.machinery) return undefined;
  return {
    schemaVersion: 1,
    maxRetainedRuns: 64,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    // The cell's cap, so a graph is stopped from the inside. The harness's
    // own poll reads the parent's session, which learns a graph's spend only
    // when the graph returns.
    ...(maxGraphCostUsd === undefined ? {} : { maxGraphCostUsd }),
    profiles: {
      worker: {
        provider,
        model: arm.worker,
        thinkingLevel: "medium",
        tools: WORKER_TOOLS,
      },
      reviewer: {
        provider,
        model: arm.reviewer,
        thinkingLevel: "medium",
        tools: REVIEWER_TOOLS,
      },
      ...(arm.testAuthor === undefined
        ? {}
        : {
            "test-author": {
              provider,
              model: arm.testAuthor,
              thinkingLevel: "medium",
              tools: WORKER_TOOLS,
            },
          }),
    },
  };
}
