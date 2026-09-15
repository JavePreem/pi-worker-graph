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
- explicit `/swarm on`, `/swarm status`, `/swarm off`, `/swarm usage`,
  `/swarm runs`, `/swarm delete`, and `--swarm` activation;
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
- an operator release of a hold whose orchestrator is gone, through `/swarm
  release`: the hold is given up and the run kept, an owner record no caller
  could validate is removed rather than parsed, a mutation in flight refuses
  the release as evidence of a live writer, and nothing reclaims a hold on
  elapsed time;
- a reviewer told how to read a checkout other workers are changing: a modified
  file outside the assignment is not evidence about the work under review, and
  another worker's change is never a finding and never to be reverted;
- an optional per-node work-review-repair cycle: a reviewer profile judges the
  worker's result against the assignment, its blockers become the repair
  worker's instructions, and the cycle repeats until a reviewer accepts or the
  round limit is reached, with a still-rejected node failing rather than
  publishing work review refused, every round's spend summed into the node's one
  attempt, and the graph left frozen because rounds are not nodes;
- configured worker profile names carried to the parent in the request while
  the mode is enabled, prepended by a `context` handler so registration stays
  static, the transcript keeps no copy, and `/swarm off` drops the block from
  the next request, read again per request so the names cannot diverge from the
  configuration the tool validates against, marked read-only only for a profile
  holding no tool that can change the checkout, and bounded by the
  configuration parser rather than by shortening a name the model must type
  exactly;
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
graph, orchestrator, report, store, and runner suites, and the bench RPC-client
suite under `bench/`. `npm run build` must run before `pi -e .`, because
`extensions/index.ts` re-exports the compiled entry point from `dist/`. The configuration copy is required rather than optional:
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

Items 1, 3 and 5 of the previous slice were verified live against Pi 0.85.1
driven headlessly in `--mode rpc`, with a throwaway agent directory supplied
through `PI_CODING_AGENT_DIR`. They are recorded here in summary rather than at
length:

- a provider-backed smoke test — two independent workers and a dependent
  validation node, real Pi subprocesses — succeeded in 22.7s. Each worker
  changed only its own file, the validation node received both prerequisite
  reports, run usage summed with nothing unaccounted, and the store kept mode
  `0700`;
- the `/swarm` command surface behaved as specified: usage text, `status`,
  `on`/`off`/repeat-`on`, `runs`, `usage <id>`, `delete <id>`, and every
  bad-argument path. `ctx.cwd` was confirmed as the working directory by
  pointing a state root inside the checkout and getting the checkout-local
  refusal;
- a configured orchestrator profile moved the parent from `gpt-5-mini` to
  `gpt-5` on `/swarm on` and back on `/swarm off`, against a real provider
  catalogue and real authentication. The shutdown restore lands: in a persisted
  session the entries run model change to the orchestrator model, the mode
  record carrying `modelBeforeMode`, then a model change back at
  `session_shutdown`. Pi awaits the handler on the graceful path, and RPC mode
  disposes the runtime host the same way interactive mode does. It is not
  awaited on `emergencyTerminalExit` or `uncaughtCrash`, where the terminal is
  already gone.

The profile-discovery gap that preceded the prerelease is closed (D21): the
configured names now reach the parent in the request while the mode is enabled,
so an orchestrated run no longer needs an out-of-band patch naming them. It is
covered by the automated suites. It is deliberately not being confirmed in a
one-off live session: the bench exercises the same path under measurement, and
a hand-run session would only tell us what the bench is built to tell us
properly.

`0.1.0-dev.2` is published and tagged, carrying the reviewer attribution fix,
the `/swarm release` operator act, the narrowed `~0.85.1` peer range, and a CI
matrix green on Node 22 and 24.

It was smoke-tested as a user gets it: installed from npm into an empty agent
directory, then a real three-node graph over three Pi subprocesses through
`bench/rpc-client.mjs`. Neither earlier check covered that combination — real
workers had only run from the checkout, and the artifact had only been loaded
offline. Everything mechanical held, down to the store at `0700` outside the
checkout with no git operation run.

The graph failed, and that was the trial's value. Both workers made exactly
their assigned edit; each node's reviewer then saw the other worker's file
modified and rejected on the criterion that no other file be changed, with
blockers asking for the sibling's work to be reverted. A reviewer is a worker
child and already carried the shared concurrency contract, but that text is
written for a worker doing work, not one reading a diff. The attribution rule
is now stated in `reviewPayload` (`src/pi-subprocess.ts`).
Re-run after the fix: all three nodes succeeded, `unaccounted` empty.

What remains, in order:

1. Finish designing the Phase 8 bench, then start working the queue.
   `bench/DESIGN.md` carries the design. It is a resumable queue rather than a
   fixed run, so it fits any budget: cells are enumerated in a fixed order, a
   run executes as many of the next pending ones as asked for, and the store
   is the state. It runs four arms, two of them solo and two through the
   orchestration machinery on different worker models, so a quality deficit can
   be attributed to the package or to the models rather than to both at once.
   The first three tasks measure the spend split, which caps the saving the
   whole experiment can report and is cheap because it is a ratio taken inside
   one run; twelve tasks across all four arms at one repetition is an estimated
   $67 to $267. What is unsettled there is two of its four open decisions,
   its three unverified dataset facts, and the feasibility spike on one
   TypeScript instance that settles them. The harness is the bulk of the work,
   and the accumulating store is the part that makes batching add up.
2. Keep every automated path provider-free behind the existing fake subprocess
   and injected orchestrator boundaries.

## Known defects

### A kill inside a mutation strands the run's mutation lock

`/swarm release` closes the hard-kill case for the owner record (D22), but the
lock is the other thing a kill can leave behind, and it is deliberately not
forced. A process killed while holding the run mutation lock leaves the file in
place with no holder, and every path that needs the lock then waits it out and
fails `locked`: the release, `deleteRun`, and a fresh `acquireRunOwnership`.
Verified against the built package — all three report "has a mutation in
flight". The run and its capacity slot are held until `mutation.lock` is
removed from the run directory by hand.

`recoverRunMutationLock` is not a way out. It takes an ownership capability,
and after a hard kill nobody holds one and nobody can acquire one.

It is recorded rather than fixed because the exposure is small and the fix is
not. The lock is held across one file write, where an owner record is held
across a whole run, so the window is orders of magnitude narrower than the one
D22 closed. Forcing it would give up the lock's stated contract — waited out
rather than resolved by force, recovered only by a holder shown to have
finished — which the deferred run-store work below depends on, and would race:
the supposed holder's release removes the file by path, so it would take a lock
acquired after it.

The fix, when something needs it, is the same shape as D22: an operator act
that names what it is giving up, not a timeout. It should wait the lock out
first, so an ordinary in-flight mutation is never interrupted, and it has to
solve the race before it is worth having.

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

**Backlogged deliberately.** Nothing currently needs a ceiling badly enough to
buy one: a graph is bounded per task by its timeout, and the operator watching
a run is the enforcement. It moves up the list only when something runs graphs
unattended.

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

## Deferred attempt and recovery work

Phase 7 is the largest slice still unbuilt: attempt history, interrupted-run
state, and explicit retry and recovery controls.

Its value is worth questioning before it is built, because the obvious reading
overstates it. The shared checkout is the real state, and the documented
recovery is already available without any of this: read the checkout with the
parent's read-only tools and invoke another narrow graph for whatever is left.
A run interrupted halfway leaves its successful work on disk, not in the store.
What is actually lost is the run's own diagnostic record — which attempt did
what, and why it stopped — and whether that is worth a persistence layer is a
different and much smaller question than "recovery".

Two things would change the answer. A worker session that could be resumed
rather than restarted would make an attempt worth persisting in its own right,
and that depends on the adapter rather than on this decision. And a consumer
that runs graphs unattended and cannot inspect a checkout between them would
need the store to say what happened; nothing does that yet.

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

Retention cleanup and worker-session resumption semantics remain deferred until
their runtime layers are implemented. Review is now partly settled: D20 gives a
node its own work-review-repair cycle, and decides that a repair is a fresh
attempt rather than a resumed child session. Whether execution also pauses at
review barriers between frontiers is independent and still open. Broader Pi
compatibility can be claimed only after testing versions beyond the current
0.85.1 development pin, and the peer range in `package.json` now declares only
that pin rather than claiming what the README withholds. CI runs the Node axis
of the question — 22 and 24, the lowest version `engines` admits and the one
development runs on (`.github/workflows/ci.yml`). The Pi axis is untested and
is the dear half: every Pi API this package binds to is one Pi may change, so
widening the peer range is a decision to take after a second version has
actually been run.
