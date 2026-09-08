# Current development status

## Implemented

The repository foundation, pure graph domain, and basic run-record lifecycle are
complete:

- TypeScript ESM package with an MIT license;
- inert Pi extension entry point;
- formatting, linting, typechecking, build, and CI configuration;
- graph normalization, aggregate validation, and iterative cycle detection;
- deterministic ready-frontier calculation and guarded node transitions;
- failed and aborted dependency blocking;
- immutable versioned run manifests with opaque task storage keys;
- parent-owned node state with graph-transition validation;
- immutable terminal node outputs;
- explicit state-root injection, restrictive permissions, and atomic publication;
- bounded UTF-8 JSON reads with visible malformed, overflow, and identity errors;
- behavioral coverage using `node:test` and temporary directories.

The package currently registers no commands or tools and starts no workers. The
store requires one parent to serialize state transitions; cross-process run
ownership is not implemented yet.

## Verify the baseline

```bash
npm install
npm run check
npm run build
pi -e .
```

`npm run check` currently runs 34 graph and store tests. Loading the package in
Pi should have no visible effect because the extension entry point is
intentionally inert.

## Next implementation slice

Build the first end-to-end core with a fake execution adapter. Keep Pi,
subprocesses, providers, events, and UI out of this slice.

1. Define one narrow asynchronous executor interface that receives task identity,
   payload, working directory, direct-prerequisite outputs, and an abort signal.
2. Add explicit runtime limits for task count, dependency count, concurrency,
   serialized payloads, and retained output before starting any task.
3. Drive `readyFrontier()` up to the configured concurrency limit.
4. Persist `running`, immutable output, and terminal state in that order before
   opening the next frontier.
5. Settle blocked descendants while allowing unrelated branches to continue.
6. Return a deterministic aggregate result after every node is terminal.

Acceptance tests should prove:

- independent fake tasks overlap without exceeding concurrency;
- dependent tasks never start early;
- terminal output is durable before a dependent starts;
- each task receives exactly its direct-prerequisite outputs;
- startup and execution failures become failed nodes;
- cancellation aborts running work and settles pending descendants;
- unrelated branches continue after another branch fails;
- no provider, network, subprocess, or Pi API is used.

Keep execution transport behind the interface. Choose subprocess versus Pi SDK
only after the fake-backed scheduler contract is stable.

## Deferred run-store work

The basic record lifecycle is intentionally not the complete Phase 2 store.
Before real worker execution, add run ownership so two orchestrators cannot
advance one run. Add bounded artifacts, events, inboxes, retention cleanup, and
Pi-specific default-path resolution only when their consumers are implemented.

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
