# Implementation plan

## Goal

Deliver a small installable Pi package that runs writable worker tasks as a DAG in
one shared checkout, propagates compact context over dependency edges, and lets
the parent orchestrator review and request revisions.

## Phase 0 — Repository foundation

- [x] Establish product boundaries, design, and decisions.
- [x] Select the `pi-worker-graph` package name and MIT license.
- [x] Add package metadata, TypeScript configuration, Biome, and `node:test`
      scripts.
- [x] Add an inert Pi extension entry point for safe local package loading.
- [x] Document one command for formatting, linting, typechecking, and tests.
- [ ] Set a Pi compatibility range when the extension first imports Pi APIs.
- [ ] Decide whether worker execution adapts the bundled subprocess example or
      uses SDK sessions behind an execution adapter.

Acceptance:

- `npm run check` runs formatting checks, lint, typechecking, and tests.
- `npm run build` emits the public graph library.
- Pi can load the local package without registering functional tools.

## Phase 1 — Pure graph domain

- [x] Graph types and normalization.
- [x] Duplicate, missing, empty, and self-edge validation.
- [x] Cycle detection.
- [x] Deterministic ready-frontier calculation.
- [x] Explicit node transitions and completion detection.
- [x] Failed and aborted dependency blocking.

Acceptance tests cover:

- empty and single-node graphs;
- flat, chain, diamond, and multi-frontier graphs;
- duplicate IDs, unknown dependencies, self-edges, and cycles;
- invalid concurrency;
- descendant blocking while unrelated branches continue;
- deterministic ordering and immutable inputs.

## Phase 2 — Run store

The basic record lifecycle is complete. Ownership, coordination, artifacts, and
cleanup remain incremental follow-up work rather than prerequisites for the
fake-backed scheduler core.

Implement run-scoped persistence outside the target checkout:

- [x] immutable versioned graph definition;
- [x] parent-owned node and attempt status;
- [x] immutable node outputs;
- [ ] bounded text artifacts;
- [ ] immutable events and directed messages;
- [x] restrictive permissions and atomic publication;
- [ ] run ownership;
- [x] bounded reads with explicit malformed and overflow errors;
- [ ] explicit text truncation and retained artifact references;
- [ ] cleanup by age and terminal status.

Acceptance tests:

- concurrent processes publish events without lost records;
- interrupted temporary writes are ignored safely;
- malformed records fail visibly without hiding valid records;
- runs cannot be mixed accidentally;
- task IDs cannot escape their run directory;
- the default state root is outside the target checkout.

## Phase 3 — Worker execution adapter

The transport-independent interface and fake-backed runner are complete. Select
and implement a Pi transport only after reviewing the applicable Pi APIs.

Implement one bounded execution path behind a testable interface:

- [x] define a narrow asynchronous execution function;
- [x] pass working directory, task identity, payload, and direct prerequisites;
- [x] enforce task, dependency, concurrency, payload, output, context, and time
      limits;
- [x] propagate abort signals and sanitize thrown executor failures;
- [ ] resolve configurable worker profiles and authentication through Pi;
- [ ] start isolated child contexts in the requested working directory;
- [ ] apply explicit worker tool allowlists;
- [ ] stream progress and capture usage;
- [ ] clean up child processes through the selected adapter;
- [ ] prevent recursive graph spawning.

Transport-independent tests use fake executors and verify:

- working directory, task, payload, and prerequisite context propagation;
- bounded concurrency, output, context, runtime, and cancellation;
- thrown and malformed executor results become bounded node failures.

The selected Pi adapter must additionally verify:

- profile and authentication resolution;
- provider and tool failures become node failures;
- no child receives graph-spawning capabilities;
- no child session state is written into the target checkout.

## Phase 4 — DAG execution and edge context

Connect the scheduler to worker execution:

- [x] run ready nodes up to the configured concurrency limit;
- [x] persist terminal results before opening the next frontier;
- [x] pass named direct-prerequisite outputs to downstream execution;
- [x] block descendants of failed prerequisites;
- [x] return deterministic aggregate graph and node status;
- [ ] validate the versioned structured worker output contract;
- [ ] return retained artifact references when truncation is implemented.

Acceptance tests:

- independent nodes overlap in wall-clock time;
- dependent nodes never start early;
- each node sees exactly its declared prerequisite outputs;
- unrelated branches continue after another branch fails;
- truncation is explicit and recoverable when an artifact is retained.

## Phase 5 — Coordination tools

Register child-only tools for:

- publishing decisions, interfaces, risks, conflicts, handoffs, and progress;
- querying relevant events with cursors;
- sending and reading directed messages;
- submitting a structured final report.

Acceptance tests:

- workers can exchange a directed message by polling;
- irrelevant events are not injected automatically;
- every event retains task and run provenance;
- oversized entries are rejected explicitly;
- successful reports satisfy the versioned schema.

## Phase 6 — Orchestrator mode

Implement:

- explicit on, status, and off commands;
- an opt-in startup flag;
- session setting snapshot and restoration;
- orchestrator guidance for decomposition, bounded overlap, review, validation,
  and repair delegation;
- graph progress UI.

Acceptance tests:

- normal Pi behavior is unchanged while mode is off;
- entering mode applies configured behavior and removes direct write tools;
- leaving restores prior settings;
- session resume restores mode state;
- child sessions do not enter orchestrator mode.

## Phase 7 — Feedback and recovery

- Define attempt and interrupted-run state.
- Persist child sessions if the selected execution adapter supports resumption.
- Let the orchestrator issue focused review feedback.
- Record attempts without losing prior outputs.
- Add explicit retry and recovery controls.

Acceptance tests:

- feedback receives the intended prior context;
- workers see the live shared checkout and intervening events;
- retries never duplicate a running attempt;
- recovery distinguishes succeeded, failed, blocked, and interrupted nodes.

## Phase 8 — Package trial and release

- Add versioned installation instructions.
- Run a controlled same-tree exercise with intentional minor overlap.
- Verify routing with at least two configurable model/provider profiles.
- Compare duration, conflicts, usage, and review findings with a sequential run.
- Document limitations and safe operating guidance.
- Publish a tagged prerelease before a stable release.

## Explicitly deferred

- Vector or semantic memory.
- Cross-machine coordination.
- A remote broker service.
- Automatic worktrees or Git mutations.
- Recursive worker trees.
- A general-purpose workflow language.
- Dynamic graph mutation.
- Live steering between workers.
