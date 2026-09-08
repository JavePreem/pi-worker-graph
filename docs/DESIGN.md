# Design

## Purpose

`pi-worker-graph` lets one Pi orchestrator execute a dependency graph of writable
workers against one shared checkout. It minimizes context sharing: immutable edge
outputs carry planned dependencies, while a small journal carries unexpected
coordination facts.

The graph domain is implemented independently of Pi. Process execution,
persistence, tools, and user interface behavior are later integration layers.

## Runtime roles

### Orchestrator

The parent Pi session:

- understands the task and repository constraints;
- defines nodes and dependency edges;
- decides which ready nodes may safely overlap;
- receives graph progress and structured results;
- reviews the integrated checkout and runs final validation;
- delegates repairs rather than editing while worker-graph mode is active.

### Worker

A child Pi session:

- receives one bounded assignment;
- operates directly in the shared checkout;
- receives outputs only from its direct prerequisites;
- may publish run-scoped coordination events or messages;
- reports a structured result;
- cannot spawn another worker.

## Graph domain

The public graph module accepts arbitrary payloads:

```ts
interface GraphTask<TPayload = unknown> {
  id: string;
  needs?: readonly string[];
  payload?: TPayload;
}

interface GraphRequest<TPayload = unknown> {
  tasks: readonly GraphTask<TPayload>[];
  concurrency?: number;
}
```

Normalization trims IDs, deduplicates and sorts dependency lists, and preserves
task order and payload identity. Validation completes before execution:

- IDs are non-empty and unique after normalization.
- Every dependency names a node in the request.
- A node cannot depend on itself.
- The graph is acyclic.
- Concurrency, when provided, is a positive integer.

Executor-specific schemas add assignment text, working directory policy, expected
paths, acceptance criteria, profiles, and hard resource limits. The runtime must
apply graph-size and dependency-count limits before invoking the graph domain.

## Node states and scheduling

Node states are:

```text
pending -> running -> succeeded
        |          -> failed
        |          -> aborted
        -> failed
        -> aborted
        -> blocked
```

Terminal states do not transition. A task can fail or abort before reaching
`running` when startup fails or cancellation arrives before execution.

Scheduling uses deterministic topological frontiers:

1. Find pending nodes whose direct prerequisites all succeeded.
2. Start eligible nodes up to the configured concurrency limit.
3. Persist each terminal result.
4. Mark pending nodes blocked when any prerequisite failed, aborted, or was
   blocked.
5. Recompute the ready frontier.
6. Finish when every node is succeeded, failed, aborted, or blocked.

A graph with no edges is an ordinary parallel batch. A linear graph is a chain.
The pure graph module returns every eligible node in a deterministic order; the
executor applies the configured concurrency limit when selecting work to start.
The graph module does not spawn workers.

## Edge context

Each worker reports a compact result:

```ts
interface NodeOutput {
  schemaVersion: 1;
  summary: string;
  changedFiles: Array<{ path: string; description: string }>;
  interfaces: string[];
  decisions: string[];
  validation: Array<{ command: string; result: string }>;
  blockers: string[];
}
```

The report schema is versioned independently of the enclosing filesystem record.
Reports require exactly these fields, use non-empty bounded strings, limit each
section's item count, and have a hard aggregate UTF-8 JSON size limit.
Changed-file paths use normalized repository-relative form; they are report data,
not authority to access a path. Untyped executor values are validated and copied
into immutable snapshots before publication. Malformed or oversized reports fail
the node. A valid report with one or more blockers also fails the node, but is
retained for parent review; its dependents do not run.

For a node, outputs from each task named directly in `needs` will be serialized
into canonical named blocks and prepended to its assignment. Worker-authored text
is treated as untrusted report data within those blocks. Full transcripts are not
propagated by default. The runtime will apply a hard size limit to every
serialized edge payload and retained artifact; truncation will be explicit and
include a reference to any retained artifact.

Persisted output records use their own envelope schema version, independently of
the worker-report schema version. Current envelopes include run and task identity,
attempt, completion time, status, and bounded diagnostics. Usage and truncation
metadata will be added with the transport and artifact layers that consume them.

## Coordination journal

Journal events are for information discovered after scheduling:

```ts
type EventKind =
  | "decision"
  | "interface"
  | "risk"
  | "conflict"
  | "handoff"
  | "progress";

interface RunEvent {
  id: string;
  runId: string;
  taskId: string;
  timestamp: string;
  kind: EventKind;
  message: string;
  paths?: string[];
  symbols?: string[];
  recipients?: string[];
}
```

Workers explicitly query relevant entries by recipient, path, symbol, or cursor.
The runtime does not inject the entire journal into every turn. Live steering is
outside the MVP.

## Persistence

The state root is resolved from runtime configuration and defaults beneath Pi's
agent data directory. It never defaults inside the target checkout.

Per-run layout:

```text
<state-root>/runs/<run-id>/
  run.json                    immutable graph and configuration
  nodes/<task-key>.json       parent-owned current node state
  outputs/<task-key>.json     terminal structured output
  artifacts/<task-key>.md     bounded textual output
  events/<task-key>/<id>.json immutable published events
  inbox/<task-key>/<id>.json  immutable directed messages
  sessions/<task-key>/...     optional child session state
```

Task IDs are validated or encoded before use as path components. Immutable
records are published by writing a same-directory temporary file with restrictive
permissions and atomically renaming it. Mutable parent-owned state is replaced
atomically. A run ownership mechanism prevents two orchestrators from advancing
the same run concurrently.

## Child process contract

Every worker receives explicit run and task identity plus the state directory.
The child detects worker mode and registers coordination and reporting tools, but
not graph-spawning tools or orchestrator commands. Secrets are not added to child
arguments, prompts, environment metadata persisted by the runtime, or graph
state.

The exact subprocess or SDK transport remains behind an execution adapter. That
adapter owns cancellation, process cleanup, progress events, timeout enforcement,
output bounds, and exit classification.

## Planned mode lifecycle

The extension is expected to provide:

```text
/swarm on
/swarm status
/swarm off
```

and an opt-in startup flag. These controls are not implemented yet.

Entering mode snapshots relevant parent session settings, selects configured
orchestrator behavior, and enables graph and review tools. Leaving restores the
snapshot. Mode state is session-scoped. Child sessions never enter orchestrator
mode.

## Failure semantics

- Invalid graph: reject before spawning.
- Worker startup, provider, or tool failure: mark the node failed with bounded
  diagnostics.
- Failed or aborted prerequisite: block dependents without running them.
- Abort: terminate running children and settle remaining nodes as aborted or
  blocked.
- Journal failure: report it; never silently claim coordination succeeded.
- Output overflow: retain bounded content and explicit truncation metadata.
- Process crash: persisted terminal nodes remain terminal; running nodes become
  interrupted and require an explicit retry or recovery decision.

`interrupted` is recovery metadata rather than a normal graph-domain terminal
state until retry semantics are defined.

## Same-tree concurrency

The runtime does not claim to make simultaneous writes safe. It reduces risk
through:

- careful graph decomposition;
- optional advisory path and symbol claims;
- instructions to re-read files before editing;
- preference for exact edits over whole-file rewrites;
- avoiding broad formatter or generator operations during a parallel frontier;
- orchestrator review of the integrated checkout;
- deterministic repository checks before acceptance.

Cross-process file locking is not part of the initial design. It would introduce
hidden serialization without protecting semantic coupling across different files.
