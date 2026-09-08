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
- behavioral coverage using `node:test`, fakes, and temporary directories.

Normal parent sessions still register no commands or tools. The public subprocess
adapter can start real workers when called, and the report tool is registered only
inside explicitly marked worker children. The store requires one parent to
serialize state transitions; cross-process run ownership is not implemented yet.

## Verify the baseline

```bash
npm install
npm run check
npm run build
pi -e .
```

`npm run check` currently runs the adapter, context, extension, graph, report,
store, and runner suites. `npm run build` must run before `pi -e .`, because
`extensions/index.ts` re-exports the compiled entry point from `dist/`.
Loading the package in Pi should have no visible effect: the entry point
registers the worker report tool only when `PI_WORKER_GRAPH_ROLE=worker`, which
the parent sets on worker subprocesses and never on its own session.

## Next implementation slice

Finish transport observability, then add the smallest configuration and graph-tool
layer:

1. Add bounded worker progress and usage capture without forwarding transcripts to
   the parent model context.
2. Resolve the default state root beneath Pi's agent directory while allowing an
   explicit override outside the checkout.
3. Load a small profile map containing provider, model, thinking level, and tool
   allowlist; keep profile selection explicit.
4. Register one static `worker_graph` orchestrator tool that validates the full
   graph and limits before invoking the subprocess-backed runner.
5. Keep automated coverage provider-free behind the fake subprocess boundary.

Provider-backed checks remain optional manual tests. Explicit orchestrator mode
and parent tool suppression follow after the graph tool works end to end.

## Deferred run-store work

Before a resumable or externally addressable run API is added, implement run
ownership so two orchestrators cannot advance one run. Add events, inboxes,
retention cleanup, and Pi-specific default-path resolution only with their
consumers. Bounded text artifacts can be added with structured-output overflow
handling.

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

Review barriers, retention defaults, and session-resumption semantics remain
deferred until their runtime layers are implemented. Broader Pi compatibility can
be claimed only after testing versions beyond the current 0.85.1 development
pin.
