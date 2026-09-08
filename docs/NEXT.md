# Current development status

## Implemented

The repository now has a small end-to-end core independent of Pi and providers:

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
- sanitized executor failures, cancellation, and task timeouts;
- task, dependency, concurrency, payload, output, and context limits;
- behavioral coverage using `node:test`, fakes, and temporary directories.

The package currently registers no commands or tools and starts no real workers.
The store requires one parent to serialize state transitions; cross-process run
ownership is not implemented yet.

## Verify the baseline

```bash
npm install
npm run check
npm run build
pi -e .
```

`npm run check` currently runs 54 graph, report, store, and runner tests. Loading
the package in Pi should have no visible effect because the extension entry point
is intentionally inert.

## Next implementation slice

Finish the deterministic edge-context boundary before selecting a real Pi
transport:

1. Serialize direct-prerequisite reports into canonical named blocks within the
   existing context limit.
2. Keep oversized reports and edge context as explicit node failures; add
   truncation and retained-artifact references only with the artifact consumer.
3. Keep the generic graph domain unchanged and keep all tests provider-free.

Acceptance tests should prove:

- each downstream task receives exactly its declared prerequisite reports;
- report and prerequisite ordering is deterministic;
- serialized context is byte-bounded and never silently truncated;
- full transcripts and undeclared output fields are never propagated.

After that boundary is stable, review Pi's subprocess and SDK examples, choose the
narrow execution adapter strategy, and set the package's Pi compatibility range.

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

Before real worker execution begins, choose the execution adapter strategy and
set an explicit Pi compatibility range. Review barriers, retention defaults, and
session-resumption semantics can remain deferred until their runtime layers are
implemented.
