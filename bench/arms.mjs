/**
 * The four arms, and the configuration each one hands the agent.
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

export const ARMS = {
  "solo-sol": { machinery: false, parent: MODELS.sol },
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
};

export function armNames() {
  return Object.keys(ARMS);
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
  { provider = PROVIDER, stateRoot } = {},
) {
  const arm = armConfig(name);
  if (!arm.machinery) return undefined;
  return {
    schemaVersion: 1,
    maxRetainedRuns: 64,
    ...(stateRoot === undefined ? {} : { stateRoot }),
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
    },
  };
}
