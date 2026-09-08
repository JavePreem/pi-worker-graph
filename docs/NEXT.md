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
- deterministic task-ordered prerequisite report serialization;
- named JSON report blocks with explicit untrusted-data labeling;
- exact UTF-8 context accounting and fail-without-truncation overflow behavior;
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

`npm run check` currently runs 60 context, graph, report, store, and runner tests.
Loading the package in Pi should have no visible effect because the extension
entry point is intentionally inert.

## Next implementation slice

Select and implement one real Pi worker transport behind the existing executor
boundary:

1. Review Pi's subprocess and SDK examples and record the selected strategy. A
   subprocess adapter is currently preferred for child isolation and termination.
2. Resolve an explicitly configured provider/model profile without introducing
   defaults.
3. Start Pi in the target working directory with a strict worker tool allowlist
   that excludes graph-spawning and orchestrator tools.
4. Deliver assignments and canonical prerequisite context without placing task
   content in child-process arguments.
5. Capture bounded reports, diagnostics, progress, and usage, and terminate the
   process tree on timeout or cancellation.
6. Keep automated coverage provider-free behind a fake subprocess boundary and
   set the package's Pi compatibility range when Pi APIs are first imported.

The adapter must treat startup, provider, tool, and process errors as bounded node
failures. Provider-backed checks remain optional manual tests.

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
