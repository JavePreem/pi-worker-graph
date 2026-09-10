# Current development status

## Implemented

The repository now has a small transport-independent core plus an initial Pi
adapter. Automated tests remain provider-free:

- normalized, fully validated DAGs with frozen graph structure;
- deterministic frontiers and guarded node transitions;
- failed and aborted dependency blocking;
- immutable versioned run manifests with opaque task storage keys;
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
- explicit `/swarm on`, `/swarm status`, `/swarm off`, and `--swarm` activation;
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
- explicit retention cleanup: a listing of everything holding capacity, and
  deletion of a named run with its slot, refused while an orchestrator holds
  the run and ordered so an interruption can only strand a slot;
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
pi -e .
```

`npm run check` currently runs the adapter, configuration, context, extension,
graph, orchestrator, report, store, and runner suites. `npm run build` must run
before `pi -e .`, because
`extensions/index.ts` re-exports the compiled entry point from `dist/`.
Loading the package in Pi adds the `/swarm` control command but leaves the parent
tool set unchanged. The entry point registers the worker report tool only when
`PI_WORKER_GRAPH_ROLE=worker`, which the parent sets on worker subprocesses and
never on its own session. Active graph lifecycles claim an exclusive owner
record before mutating run state; resumable or externally addressable runs are
not implemented yet.

## Next implementation slice

Prepare the vertical slice for a prerelease:

1. Run an optional provider-backed smoke test with two independent workers and a
   dependent validation node when provider-backed testing is desired; this is
   intentionally skipped for the current local pass.
2. Review, tag, and publish the npm prerelease through the maintainer-owned Git
   and registry workflow.
3. Decide whether cleanup needs a surface inside Pi — a `/swarm` control command
   or a parent tool — or whether the store API is enough for the prerelease.
4. Keep every automated path provider-free behind the existing fake subprocess
   and injected orchestrator boundaries.

## Deferred run-store work

Before a resumable or externally addressable run API is added, retain the
fail-closed ownership contract so two orchestrators cannot advance one run, and
the rule that a mutation lock is recovered only by a holder that can be shown
to have finished. Bounded text artifacts can be added with structured-output
overflow handling, and their retained files must be removed with the run.

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
