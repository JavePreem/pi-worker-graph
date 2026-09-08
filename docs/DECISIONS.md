# Decisions

This page records stable product decisions for the initial implementation.
Unresolved choices remain under **Open decisions**.

## Decisions of record

### D1 — Public standalone package

The project is a reusable, application-independent Pi package named
`pi-worker-graph`. It is released under the MIT license.

### D2 — DAG edges are the primary context mechanism

A node receives compact structured outputs only from nodes named directly in its
`needs` list. Full sibling transcripts and transitive context dumps are not
injected.

### D3 — The filesystem is authoritative for code

Workers share one checkout. Graph state records coordination facts, decisions,
interfaces, risks, and handoffs; it does not duplicate source files.

### D4 — Same-tree writes are intentional

Writable workers do not receive automatic worktrees. Bounded overlap is allowed
when the orchestrator judges it worthwhile. The orchestrator reviews the
integrated checkout before accepting the result.

### D5 — No automatic Git lifecycle

The runtime never branches, commits, merges, pushes, stashes, resets, restores,
or cleans. Git may be used read-only for review and diagnostics.

### D6 — Shared coordination is append-only and run-scoped

Coordination events live outside the target checkout. Each event is an immutable
file created atomically, avoiding concurrent mutation of one shared document.
Runs are isolated from one another.

### D7 — The orchestrator owns acceptance

A worker success report is evidence, not acceptance. The orchestrator reads the
actual changes, runs checks, and either accepts the result or delegates a focused
repair.

### D8 — Runtime activation is explicit

The future extension will not alter normal Pi behavior until worker-graph mode is
explicitly enabled. Leaving the mode restores the previous session settings.

### D9 — Models and providers are configuration

The graph domain has no provider dependency or model default. Runtime profiles
will accept configurable model, provider, thinking-level, and tool settings.
Tests use fakes and make no provider calls.

### D10 — No recursive delegation initially

Workers receive coding and coordination tools, but not the graph-spawning tool.
The orchestrator alone controls execution of the initial immutable graph.

### D11 — Pure graph domain first

The first implementation layer is dependency-free and independent of Pi,
processes, persistence, and providers. Integration layers build on its validated
state transitions and deterministic scheduling behavior.

### D12 — Static graph and pull-based coordination for the MVP

The graph is immutable after execution starts. Coordination events and directed
messages are read explicitly rather than injected globally or delivered as live
steering messages.

### D13 — Pi workers use isolated subprocesses

The MVP runs each worker as a one-shot Pi JSON-mode subprocess. The parent sends
task content over stdin, applies an explicit provider/model profile and strict
tool allowlist, disables discovered extensions, skills, prompts, and session
persistence, and loads only the child report extension. This provides a clear
process-tree cancellation boundary and keeps worker failures isolated from the
orchestrator. SDK sessions remain a possible post-MVP optimization, not a second
MVP transport.

### D14 — Pi compatibility follows package peer conventions

Pi-facing code is currently tested against `@earendil-works/pi-coding-agent`
0.85.1. The package declares Pi's extension-provided imports as `"*"` peers, as
required by Pi package conventions, while pinning the tested versions in
development dependencies. Compatibility outside the tested version is not
claimed until a broader matrix exists.

## Open decisions

1. Whether review feedback resumes a persisted child session or starts a fresh
   attempt with the prior structured output.
2. Whether advisory path and symbol claims belong in the MVP or a follow-up.
3. Retention defaults and cleanup policy for completed run state.
4. Whether the extension exposes one multi-action tool or several focused tools.
5. Whether graph execution pauses at explicit review barriers between frontiers.
