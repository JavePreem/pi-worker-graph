# Current development status

## Implemented

The repository now has a small transport-independent core plus an initial Pi
adapter. Automated tests remain provider-free:

- normalized, fully validated DAGs with frozen graph structure;
- deterministic frontiers and guarded node transitions;
- failed and aborted dependency blocking;
- immutable versioned run manifests with opaque task storage keys;
- one bounded retained text artifact per task attempt, published deliberately
  through an optional `worker_graph_report` field, revalidated at every
  boundary it crosses, published before and vouched for by the output that
  references it, kept off dependency edges, named by byte length in the
  parent-facing result, and removed with its run;
- report and prerequisite-context overflow that stay fail-closed rather than
  truncating into an artifact;
- per-attempt token and cost accounting persisted with the attempt, kept for a
  failed, timed-out, or aborted attempt as well as a succeeded one, summed per
  run through `/swarm usage` and `readRunUsage()`, and attributed per task in
  the parent-facing result;
- accounting that keeps zero and unknown apart: absent or unusable telemetry
  leaves an attempt unaccounted rather than free, a run total is only summed
  from outputs that agree with node state, and a task that never ran is
  reported apart from one that ran and recorded nothing;
- parent-owned node state and immutable terminal outputs;
- restrictive permissions and atomic filesystem publication;
- bounded UTF-8 JSON records with explicit read and identity errors;
- an injected asynchronous task-executor interface;
- a strict versioned structured worker-report contract;
- defensive report validation and immutable JSON snapshots;
- normalized repository-relative changed-file paths and bounded diagnostics;
- blocker-bearing report failure with retained parent-visible output;
- bounded concurrent DAG execution with deterministic frontier selection;
- durable terminal output before dependent activation;
- direct-prerequisite-only output propagation;
- deterministic task-ordered prerequisite report serialization;
- named JSON report blocks with explicit untrusted-data labeling;
- exact UTF-8 context accounting and fail-without-truncation overflow behavior;
- explicit provider/model/thinking/tool worker profiles with no model defaults;
- one-shot Pi JSON-mode subprocess workers in the target checkout;
- task delivery over stdin rather than child-process arguments;
- child isolation from discovered extensions, skills, prompt templates, and sessions;
- a child-only terminating structured final-report tool, with recoverable
  rejection so a worker can correct and resubmit a report;
- enforcement that the report really was the worker's final action, covering
  Pi's parallel tool batches;
- positive identification of Pi's executable, with no shell on any platform;
- event-stream framing bounds that skip unparseable lines instead of failing a
  worker whose transcript is legitimately large;
- allowlisted adapter failure diagnostics, surfaced through one pre-run error
  type and one execution failure type;
- process-group cancellation with forced termination fallback and post-exit
  collection of orphaned grandchildren;
- sanitized executor failures, cancellation, and task timeouts;
- task, dependency, concurrency, payload, output, and context limits;
- bounded, redacted worker progress projection and aggregate usage accounting;
- a strict global `worker-graph.json` profile configuration;
- a default state root beneath Pi's agent directory, with checkout-local roots
  rejected by the extension;
- one static, fully bounded `worker_graph` parent tool;
- explicit `/swarm on`, `/swarm status`, `/swarm off`, `/swarm usage`, and
  `--swarm` activation;
- an optional configured orchestrator session model and thinking level, applied
  on activation and restored on exit, refused unless the mode knows the
  identifiers that restore it, the model is one Pi can find, and its provider
  is authenticated, with a model the configuration stopped naming still put
  back and a restore that cannot be performed reported rather than swallowed;
- session-persisted swarm mode with exact active-tool restoration and built-in
  parent mutation tools suppressed while active, with branch-recorded state
  governing session-tree navigation and activation refused for any tool set the
  extension could not restore;
- compact, explicitly bounded worker-report projection for parent review and
  focused follow-up graphs, delivered in a labeled block worker text cannot
  close;
- a configurable retained-run cap enforced by atomically claimed capacity slots,
  with deterministic arbitration between concurrent creators, no implicit
  deletion, stranded slots reported for explicit removal, and inconsistent
  run/slot state failing closed;
- explicit retention cleanup through `/swarm runs` and `/swarm delete`: a
  listing of everything holding capacity, and deletion of a named run with its
  slot, refused while an orchestrator holds the run and ordered so an
  interruption can only strand a slot;
- immutable bounded run-scoped coordination events and directed inbox messages,
  in one run-global journal, with cursor-based queries and child-only Pi tools;
- a run mutation lock that names its holder, so contention between the parent
  and a publishing worker is reported apart from an ownership conflict, waited
  out rather than resolved by force, and recovered only when the lock names a
  task the graph runner knows has finished;
- coordination cursors that run past records a reader is never given, so
  polling costs only the records published since the previous call;
- a verified npm artifact containing the compiled runtime, loaded from a clean
  temporary install in offline Pi RPC mode;
- behavioral coverage using `node:test`, fakes, and temporary directories.

Normal parent sessions register the `/swarm` control command, but the
`worker_graph` tool is inactive until explicitly enabled. The report tool is
registered only inside explicitly marked worker children. Active graph
lifecycles claim an exclusive owner before mutating run state; resumable or
externally addressable runs are not implemented yet.

## Verify the baseline

```bash
npm install
npm run check
npm run build
cp docs/worker-graph.example.json ~/.pi/agent/worker-graph.json
pi -e .
```

`npm run check` currently runs the adapter, configuration, context, extension,
graph, orchestrator, report, store, and runner suites. `npm run build` must run
before `pi -e .`, because `extensions/index.ts` re-exports the compiled entry
point from `dist/`. The configuration copy is required rather than optional:
the extension has no provider or model defaults, and `/swarm runs` and
`/swarm delete` resolve the state root through the same file, so a missing
`worker-graph.json` answers both subcommands with a configuration error.
Loading the package in Pi adds the `/swarm` control command, whose `runs` and
`delete` subcommands work whether or not the mode is enabled, but leaves the
parent tool set unchanged. The entry point registers
the worker report tool only when `PI_WORKER_GRAPH_ROLE=worker`, which the
parent sets on worker subprocesses and never on its own session. Active graph
lifecycles claim an exclusive owner record before mutating run state; resumable
or externally addressable runs are not implemented yet.

## Next implementation slice

Prepare the vertical slice for a prerelease:

1. Run an optional provider-backed smoke test with two independent workers and a
   dependent validation node when provider-backed testing is desired; this is
   intentionally skipped for the current local pass.
2. Review, tag, and publish the npm prerelease through the maintainer-owned Git
   and registry workflow.
3. Type `/swarm runs` and `/swarm delete <run-id>` once in a live Pi session.
   Their state-root resolution has now been exercised against a real agent
   directory: a real `worker-graph.json` resolved the default
   `~/.pi/agent/worker-graph` root, and a created run was listed with its slot
   and then deleted, leaving `runs/slots` empty at mode `0700`. What remains
   unverified is the command surface itself — argument parsing, the notified
   text, and `ctx.cwd` as the working directory — because those need the
   interactive session rather than a direct store call.
4. Keep every automated path provider-free behind the existing fake subprocess
   and injected orchestrator boundaries.
5. Exercise the configured orchestrator model once in a live session. Its
   activation, refusal, and restore paths are covered by fakes; what no test
   can cover is Pi's own `setModel` against a real provider catalogue and real
   authentication. Confirm specifically whether the shutdown restore lands:
   `session_shutdown` awaits an asynchronous model change, and Pi does wait for
   that handler on both quit paths: `interactive-mode.js` awaits
   `runtimeHost.dispose()`, which awaits `emitSessionShutdownEvent`, which
   awaits each handler in turn. It is not awaited on `emergencyTerminalExit`
   or `uncaughtCrash`, where the terminal is already gone.

## Deferred run-store work

Before a resumable or externally addressable run API is added, retain the
fail-closed ownership contract so two orchestrators cannot advance one run, and
the rule that a mutation lock is recovered only by a holder that can be shown
to have finished.

Retained text artifacts are complete end to end and their policy is settled in
D19: publication is deliberate, and neither overflow becomes truncation.

One question is left open deliberately. The orchestrator learns that an
artifact exists, and how large it is, but has no way to read it: the review
names `artifactBytes` and not a path, and no tool returns the text. A library
caller uses `readNodeArtifact()`. Giving the orchestrator the artifact's path
would make its own `read` tool sufficient, but that widens what the parent may
reach outside the checkout, so it is a decision rather than an addition.

## Deferred worker instruction work

The worker concurrency contract is now sent in the worker prompt
(`src/pi-subprocess.ts`) and asserted by the adapter suite: stay inside the
assignment, prefer small exact edits, reconcile rather than restore a file to
the version first read, never run git restore/reset/checkout/stash/clean and
never commit, push, or branch, no repository-wide formatters or generators or
dependency updates without explicit ownership, re-read changed files before
reporting, and report an unclear semantic conflict as a blocker instead of
guessing. The orchestrator guidance in `src/orchestrator.ts` carries the
matching parent-side decomposition, overlap, serialization, and acceptance
rules.

What remains undecided is one report field. `NodeOutput` carries `summary`,
`changedFiles`, `interfaces`, `decisions`, `validation`, and `blockers`
(`src/output.ts`), so an observation about another worker's edits can only
reach the parent's terminal report as prose in `summary` or as a blocker.
Adding a field is a schema version change.

It is less pressing than it was. A worker that notices a concurrent change
already has a structured channel while it runs — a `conflict` coordination
event (`src/store.ts`), which the parent and other workers can read — and a
retained artifact for the long form of what it saw. Neither is the terminal
report, so the question stands; it is no longer a dead end.

## Deferred budget work

Usage is now recorded but nothing acts on it. The runtime bounds tasks,
concurrency, payload, output, context, and per-task runtime; it has no token or
cost ceiling, so a graph can spend without limit as long as each worker stays
inside its timeout.

The next slice is a configured budget in `worker-graph.json`, checked in the
runner between frontiers and enforced through the existing abort path, which
already settles remaining nodes and returns a result with usage intact. Two
things to settle first: whether the budget counts tokens or cost — cost is the
provider's estimate, tokens are the sturdy number — and whether crossing it
aborts the graph or only refuses to open the next frontier.

## Constraints to preserve

- Keep the implementation and exported API as small as possible.
- Validate the complete graph and runtime bounds before starting work.
- Do not add provider or model defaults.
- Do not add automatic Git operations or worktrees.
- Do not store runtime state in the target checkout by default.
- Do not propagate undeclared or unbounded context between tasks.
- Do not add recursive worker delegation.
- Use fake executors for automated integration tests.

## Decisions still needed

Review barriers, retention cleanup, and worker-session resumption semantics
remain deferred until their runtime layers are implemented. Broader Pi
compatibility can be claimed only after testing versions beyond the current
0.85.1 development pin.
