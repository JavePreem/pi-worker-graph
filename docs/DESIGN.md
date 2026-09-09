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

For a node, outputs from each task named directly in `needs` are serialized in
task-ID order into canonical named JSON blocks for the execution adapter to
prepend to its assignment. Worker-authored text is explicitly marked as
untrusted report data within those blocks. Full transcripts and undeclared report
fields are not propagated. The complete serialization, including block labels
and the warning, is measured in UTF-8 bytes against a hard limit. Overflow fails
the downstream node without truncation. If truncation is added later, it will be
explicit and include a reference to a bounded retained artifact.

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
  schemaVersion: 1;
  kind: "run-event";
  eventId: string;
  runId: string;
  taskId: string;
  timestamp: string;
  eventKind: EventKind;
  message: string;
  paths?: string[];
  symbols?: string[];
  recipients?: string[];
}
```

Directed messages carry the same envelope with a sender and one recipient task.

Workers explicitly query relevant entries by recipient, path, symbol, or cursor.
The runtime does not inject the entire journal into every turn. Live steering is
outside the MVP.

Every record in a run shares one monotonic sequence, so an identifier is also a
position: a cursor names a point that no later record can precede, and a worker
polling with one cannot silently skip a record published between two reads. The
sequence is allocated by exclusively creating a claim file, so concurrent
workers are arbitrated by the filesystem rather than by a lock a crashed worker
could hold. An interrupted publisher leaves an unused number rather than an
identifier a second worker could reuse.

Coordination is bounded on both sides. A run retains a fixed maximum number of
records, and publishing past it fails explicitly instead of silently degrading
reads. A read is bounded by a requested record count and by a serialized page
size, and reports a cursor for the remainder, so one large record cannot enlarge
a worker's context beyond the page bound.

Publishing requires the run to have an active owner, but not the owner's
capability. Workers are the authors of coordination records and never hold the
capability that advances node state, so an unowned or finished run stays
immutable while worker writes remain unprivileged. Records are attributed to a
task rather than authenticated: every worker of a run shares this state root, as
they already share the checkout.

## Persistence

The state root is resolved from runtime configuration and defaults beneath Pi's
agent data directory. It never defaults inside the target checkout. A bounded
run count is enforced through atomically created run reservations. Reaching the
limit fails before a worker starts and never deletes prior state implicitly.

Per-run layout:

```text
<state-root>/runs/<run-id>/
  run.json                    immutable graph and configuration
  owner.json                  exclusive active lifecycle owner
  nodes/<task-key>.json       parent-owned current node state
  outputs/<task-key>.json     terminal structured output
  artifacts/<task-key>.md     bounded textual output
  coordination.seq/<id>.json  run-global coordination sequence claims
  events/<task-key>/<id>.json immutable published events
  inbox/<task-key>/<id>.json  immutable directed messages
  sessions/<task-key>/...     optional child session state
```

Task IDs are validated or encoded before use as path components. Immutable
records are published by writing a same-directory temporary file with restrictive
permissions and atomically renaming it. Mutable parent-owned state is replaced
atomically. One extension instance permits only one graph lifecycle at a time.
Active graph execution claims an exclusive owner record before mutating node
state or outputs. Each mutation also holds a per-run filesystem lock through its
full asynchronous read/validate/commit sequence, so ownership cannot be
released and reassigned mid-mutation. Resumable or externally addressable runs
still require an API that acquires and verifies that ownership before advancing
an existing run.

## Child process contract

Every worker receives explicit run and task identity plus the state directory,
and no other runtime state; in particular it never receives the run's ownership
capability. The child detects worker mode and registers coordination and
reporting tools, but not graph-spawning tools or orchestrator commands. Pi's
tool allowlist is strict over built-in and extension tools, so the adapter
allowlists the coordination tools on exactly the condition under which the child
registers them, and advertises them in the assignment only then. Secrets are not
added to child arguments, prompts, environment metadata persisted by the
runtime, or graph state.

The MVP transport is a one-shot Pi JSON-mode subprocess behind the execution
adapter. It runs without session persistence or discovered extensions, skills,
and prompt templates; only an explicit built-in tool allowlist and the child
report extension are active. Repository context files remain enabled as trusted
worker instructions. Task content is sent over stdin rather than argv.
The adapter owns process-group cancellation, forced cleanup, event-stream
framing bounds, and bounded exit classification. It projects capped progress
snapshots containing only task identity, phase, allowlisted tool names, and
numeric usage. Worker text and tool payloads are not forwarded to the parent.

Classification favours completed work over incidental process noise. A captured,
validated report outranks a provider error or a nonzero exit reported after it,
because the report is the task contract and the child is already finished by
then. Cancellation and a distrusted event stream still outrank a report, since
neither leaves it trustworthy. Bounds that protect the parent are framing bounds:
an unparseable line is skipped, never fatal, so a worker that legitimately emits
a large transcript is not failed after its edits have landed.

A report only counts when it was genuinely the worker's last action. Pi batches
the tool calls of one assistant message and honours a terminating result only
when the whole batch terminates, so the adapter reconstructs the batch the
report belonged to from the assistant `message_end` event and watches for tool
executions after it. A report that shared its batch, or that work outlived, is
rejected rather than reported as success.

The worker executable is identified positively rather than inferred. The adapter
resolves Pi's CLI entry point through this package's dependency on Pi and runs it
with the current JavaScript runtime, so there is no `PATH` search and no command
interpreter on any platform. `PI_CODING_AGENT` is not evidence of identity — Pi
exports it into every process it starts, including programs run by its own `bash`
tool — so it only corroborates the single-file-build case, where the running
executable is neither `node` nor `bun`. When neither route identifies Pi, the
adapter requires an explicit command instead of guessing through a shell.

## Mode lifecycle

The extension provides:

```text
/swarm on
/swarm status
/swarm off
```

and an opt-in startup flag. The parent `worker_graph` tool is registered once but
removed from the active tool set until the mode is enabled. Worker children take
a mutually exclusive extension path and receive only their final-report tool.

Entering the mode snapshots the complete active-tool set, removes the built-in
`bash`, `edit`, and `write` tools, and activates `worker_graph` in their place.
The snapshot and enabled state are stored in a bounded custom Pi session entry,
restored on resume and tree navigation, and restored exactly when the mode ends.
Worker children never register this lifecycle.

## Failure semantics

- Invalid graph: reject before spawning.
- Worker startup, provider, or tool failure: mark the node failed with bounded
  diagnostics.
- Failed or aborted prerequisite: block dependents without running them.
- Abort: terminate running children and settle remaining nodes as aborted or
  blocked.
- Journal failure: report it; never silently claim coordination succeeded.
- Worker-report overflow: fail the node; compact parent review projections mark
  every truncated field or omitted report explicitly.
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
