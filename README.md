# pi-worker-graph

A small DAG-first worker orchestration runtime for the
[Pi coding agent](https://github.com/earendil-works/pi).

`pi-worker-graph` is designed for one orchestrator coordinating multiple writable
workers in a shared checkout. Dependency edges control scheduling and carry
bounded structured context; an optional run-scoped journal carries facts
discovered while work is in progress.

## Status

Early implementation. The package currently provides tested graph primitives,
a versioned structured worker-report contract, canonical byte-bounded
prerequisite context, an explicit-root filesystem store, a bounded DAG runner,
a one-shot Pi subprocess adapter, immutable run-scoped coordination events and
inboxes, and an explicitly activated parent orchestration tool. The parent tool
is inactive by default; worker children receive only the final-report and
coordination tools.

## Setup

The extension has no provider or model defaults, so it does not run until a
configuration exists. Copy the example and edit its profiles:

```bash
mkdir -p ~/.pi/agent
cp docs/worker-graph.example.json ~/.pi/agent/worker-graph.json
```

The npm artifact ships `docs/` too, so the same file is present in an installed
copy of the package.

Every profile must name its `provider`, `model`, `thinkingLevel`, and `tools`
explicitly; unknown fields are rejected. Valid thinking levels are `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Valid worker tools are
`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. A graph
task selects a profile by name, so the name in the example is illustrative
rather than required.

Profiles configure workers. The capable model belongs on the parent, which
decomposes the work, reads the integrated checkout, and decides acceptance; a
worker executes one narrow assignment the parent already scoped, so the example
configures a cheaper model here. Add further profiles when tasks genuinely need
different capability or a narrower tool set.

The parent session can be configured in the same file, through an optional
`orchestrator` block:

```json
{
  "orchestrator": {
    "provider": "anthropic",
    "model": "claude-opus-4-5",
    "thinkingLevel": "high"
  }
}
```

Enabling the mode then moves the session onto that model and restores the
previous one on `/swarm off` and on leaving the branch. Shutdown attempts the
same restore, but it is a best effort: the model is put back through an
asynchronous Pi call, and a session ending need not wait for it. A restore that
cannot be performed at all — the earlier model has left Pi's catalogue, or its
provider lost authentication — is reported rather than passed over in silence.
The block has no `tools` field: the parent's tools stay governed by the mode's
own snapshot.
`thinkingLevel` accepts every level a worker profile accepts except `off`,
which Pi's session thinking level cannot express.

The block is deliberately absent from the example, because a model your Pi
install cannot find would refuse to enable the mode. Leave it out and the
parent stays exactly as you started it, with its model coming from Pi's own
settings or preset.

A valid configuration is required to enable the mode at all, and by `/swarm
runs` and `/swarm delete`, which resolve the run-store state root through it.
See [Orchestrator tool](#orchestrator-tool) for `stateRoot`,
`maxRetainedRuns`, and the activation commands.

## Graph semantics

- The complete graph is validated before execution.
- Task IDs are normalized, non-empty, and unique.
- Dependencies must exist, cannot refer to the same task, and must be acyclic.
- A task becomes ready only after all direct prerequisites succeed.
- Failed, aborted, or blocked tasks block their descendants.
- Unrelated branches remain eligible to run.
- Ready task ordering is deterministic.

```ts
import {
  createInitialState,
  normalizeGraph,
  readyFrontier,
  setNodeStatus,
} from "pi-worker-graph";

const graph = normalizeGraph({
  tasks: [
    { id: "api", payload: { task: "Implement the API" } },
    { id: "ui", payload: { task: "Implement the UI" } },
    {
      id: "integration",
      needs: ["api", "ui"],
      payload: { task: "Integrate and validate" },
    },
  ],
  concurrency: 2,
});

let state = createInitialState(graph);
console.log(readyFrontier(graph, state)); // ["api", "ui"]

state = setNodeStatus(graph, state, "api", "running");
state = setNodeStatus(graph, state, "api", "succeeded");
```

The graph module is generic over `payload` and has no provider, model, process,
filesystem, or Pi runtime dependency. `readyFrontier()` returns every eligible
task; `runGraph()` applies concurrency and fixed resource limits when selecting
and executing work through an injected adapter.

## Worker reports

A completed task executor must return a complete schema-versioned `NodeOutput`
containing its summary, changed files, interfaces, decisions, validation, and
blockers. Changed-file paths are normalized repository-relative paths. Reports
reject unknown fields, empty or oversized text, excessive item counts, hostile
values, and oversized serialized JSON. `parseNodeOutput()` validates untrusted
values and returns an immutable snapshot suitable for publication or
dependency-edge propagation. A report with blockers fails its node, retains the
report for review, and blocks dependents.

Direct-prerequisite reports are serialized in deterministic task-ID order into
named JSON blocks. The complete UTF-8 context, including labels and an explicit
untrusted-worker-data warning, is measured against a hard byte limit. Oversized
context fails the downstream node and is never silently truncated. Only the
validated reports of declared direct prerequisites are included.

A worker may also retain one bounded text artifact beside its report, through
the optional `artifact` field on `worker_graph_report`: supplemental long-form
material such as a log, investigation notes, or detailed review findings. It is
a sibling of the report rather than a field of it, so the report envelope stays
at schema version 1 and the artifact is bounded separately. The runtime never
parses it and never places it on a dependency edge, so a report that leans on
its artifact is an incomplete report. It is stored under the run, the output
envelope records the byte length that vouches for it, and it is removed when
the run is deleted. `readNodeArtifact()` reads it back, and the orchestrator
tool result names its byte length so a retained artifact is discoverable. An
aborted task produced nothing to retain and may not publish one.

Neither overflow becomes truncation. An oversized report is rejected so the
worker can correct and resubmit it, and oversized prerequisite context fails
the downstream node rather than handing it a partial prerequisite contract.

## Pi worker adapter

`createPiSubprocessExecutor()` selects an explicitly named worker profile for
each task. It starts one ephemeral Pi JSON-mode child in the target checkout,
disables discovered extensions, skills, prompts, and session persistence, and
applies a strict built-in tool allowlist plus the child-only report tool. Task
assignments and edge context are written to stdin and never added to child-process
arguments.

```ts
import { createPiSubprocessExecutor, runGraph } from "pi-worker-graph";

const executor = createPiSubprocessExecutor({
  profiles: {
    worker: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "edit", "write"],
    },
  },
});

await runGraph({
  stateRoot: "/path/outside/the/checkout",
  workingDirectory: process.cwd(),
  executor,
  graph: {
    tasks: [
      {
        id: "implementation",
        payload: {
          profile: "worker",
          assignment: "Implement the requested change",
          acceptanceCriteria: ["Tests pass"],
          expectedPaths: ["src/"],
        },
      },
    ],
  },
});
```

The adapter requires a valid terminating `worker_graph_report` call, maps
process/provider/report failures to fixed safe diagnostics, and terminates the
child process group on cancellation. Automated tests use fake subprocesses and
make no provider calls.

Event-stream handling is deliberately tolerant of normal worker behaviour. Pi's
JSON mode reports every session event, so single lines carry whole tool results
and whole assistant messages; lines too large to parse are skipped rather than
failing the task, and the framing bound is derived from the report envelope so a
valid report can never be skipped. A rejected report is recoverable: the worker
may correct and resubmit it, and only a worker that never produces a valid
report fails on that signal. Once a report is captured, a provider error or a
nonzero exit afterwards does not discard it — the structured report is the task
contract. Cancellation still outranks a captured report.

The report must also be the worker's *last* action. Pi executes the tool calls
of one assistant message as a batch, and a terminating result only ends the
session when every result in that batch terminates, so a report called alongside
`write` or `bash` leaves the worker running. The adapter tracks the batch the
report belonged to and any tool that runs afterwards, and fails such a task
instead of accepting a report that work outlived.

With no explicit `command`, the adapter locates Pi's CLI entry point through
this package's dependency on Pi and runs it under the current JavaScript
runtime. Nothing is inferred from `PI_CODING_AGENT`, which Pi exports to every
process it launches, and no command interpreter is involved on any platform.
Supply `command` when Pi cannot be resolved that way.

An executor rejects with `TaskExecutionFailure`, whose diagnostics come from a
fixed allowlist, so no provider text or repository content reaches persisted run
state. `runGraph` reports a graph the executor refuses through
`RunGraphValidationError` with an `adapter_validation` issue, the same error type
as every other pre-run rejection.

The adapter projects bounded progress snapshots containing only task identity,
phase, allowlisted tool name, and numeric usage. Worker text, tool arguments,
tool results, and stderr are never included. Progress callbacks are capped and
cannot alter worker execution if an observer throws.

## Worker coordination

Workers receive four child-only tools for facts discovered after scheduling:
`worker_graph_event` publishes one bounded coordination fact, optionally
addressed to named tasks and tagged with paths or symbols;
`worker_graph_message` sends one directed handoff; `worker_graph_events` and
`worker_graph_inbox` read them. Nothing is injected automatically — a worker
reads only what it asks for — and returned records are labeled as untrusted
worker-authored data.

Every record in a run shares one monotonic sequence, so an identifier is also a
position: a cursor cannot skip a record published between two reads. Claiming a
sequence number and storing the record it names are one exclusive create in one
journal, so no identifier is ever reserved for a record that lands after a
reader has been handed a cursor past it. A read is bounded by a requested record
count and by the serialized JSON array size, including its brackets and
separators. This holds strictly because every record is bounded at 32 KiB when
published, half of one 64 KiB page; a read returns a cursor for the remainder.
Both kinds share the journal, so a read also passes over records it is never
given — the other kind, another task's mail — and its cursor runs past them, so
polling an inbox costs only the records published since the last call rather
than the whole journal each time. A cursor therefore belongs to the query that
produced it, and a page can come back empty with one; a reader stops when no
cursor is returned.
Publication synchronizes the active-owner check with ownership release. The
parent and every worker contend for one run mutation lock, which is claimed by
linking a record that already names its holder, so contention with a live
worker is never mistaken for a lock a killed worker left behind: a parent
mutation waits contention out and recovers a lock only when it names a task of
its own graph that has already finished. Publication requires the run to have
an active owner but not the orchestrator's ownership capability, which never
leaves the parent,
so workers cannot advance node state or publish another task's output. Records
are attributed to the publishing task rather than authenticated: workers of one
run share the state root as they already share the checkout.

A run retains at most 256 coordination records. Publishing past that, or a
record over its size bound, fails explicitly and the worker continues without
it; as with retained runs, nothing is deleted automatically, so reclaiming the
capacity means deleting the run directory and its slot together.

## Orchestrator tool

The extension reads `worker-graph.json` from Pi's agent directory (normally
`~/.pi/agent`); [`docs/worker-graph.example.json`](docs/worker-graph.example.json) is
a copyable starting point. The configuration is byte-bounded, rejects unknown
fields, and requires every worker profile to select its provider, model,
thinking level, and tool allowlist explicitly:

```json
{
  "schemaVersion": 1,
  "maxRetainedRuns": 64,
  "profiles": {
    "worker": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "thinkingLevel": "medium",
      "tools": ["read", "bash", "edit", "write"]
    }
  }
}
```

Run state defaults to the `worker-graph` subdirectory of Pi's agent directory.
An optional `stateRoot` may be absolute or relative to the agent directory, but
the extension rejects the filesystem root and any path that is inside the target
checkout, including through an existing symlink.
`maxRetainedRuns` defaults to 64 and may be set from 1 through 256. Capacity is
a fixed set of slot files under `runs/slots`, so the limit is structural: at
most that many slots can exist, so at most that many runs can publish, and
concurrent creators are arbitrated by the filesystem rather than by counting —
an available slot is always claimed by exactly one of them. A slot is claimed by
hard-linking a record that is already complete on disk, so an interrupted
creation can never leave a slot that holds capacity without naming its owner.
Reaching the limit rejects the new graph; run state is never deleted
automatically.

A creation interrupted between claiming its slot and publishing its run leaves
the slot claimed. `/swarm runs` names everything holding capacity — each run
with its slot and creation time, a slot whose run was never published, and a
run whose slot is missing — and `/swarm delete <run-id>` removes a named run's
directory and its slot together. The same operations are exported as
`listRetainedRuns()` and `deleteRun()`. They are a command and not a parent
tool: deleting a run destroys the diagnostic state it was kept for, so it is an
operator's act and the model has no way to reach it. Cleanup is by name:
nothing decides on the operator's behalf which diagnostic state is worth
losing, so there is no deletion by age or by count. A run an orchestrator holds
is refused. The directory goes first and the slot second, so an interruption
strands a slot the store reports as reclaimable rather than leaving a published
run whose slot is missing: that disagreement stops the store admitting any new
work at all — rather than letting every waiting creator claim the same
apparently free capacity — until the two agree again.

Load the package and activate orchestration explicitly:

```text
/swarm on
/swarm status
/swarm off
/swarm runs
/swarm delete <run-id>
```

The `--swarm` extension flag enables the mode at startup. While the mode is
off, the `worker_graph` tool is excluded from the active tool set. Enabling the
mode snapshots the active tools, disables the built-in `bash`, `edit`, and
`write` tools in the parent, and persists the mode state in the Pi session.
Turning it off restores the exact snapshot. When the configuration names an
`orchestrator` block, the same snapshot covers the parent's model and thinking
level, and enabling the mode is refused outright unless the mode first knows
the identifiers that put the session back, the configured model is one Pi can
find, and its provider has configured authentication; a refusal applies
nothing. Navigating the session tree
restores whatever the target branch recorded, so `/swarm off` is never undone
by the flag that started the session. A tool set the extension could not read
back — more than 256 tools, or a tool name longer than 256 bytes — refuses to
enable the mode rather than suppressing parent tools it could not restore after
a reload. While a graph runs, the tool streams bounded status and returns
deterministic node statuses, aggregate usage, and a compact bounded projection
of worker reports. Worker transcripts never enter the parent model context;
projected report fields are marked as untrusted data inside a labeled block
that worker text cannot close.

Only one graph may run in a parent session at a time. Include validation as a
dependent worker task. After reviewing the shared checkout with the remaining
read-only tools, invoke another narrow graph for any repairs.

## Planned runtime

The remaining runtime will add:

- persisted worker attempts and interrupted-run recovery behavior.

Writable workers will intentionally share one checkout. The runtime will not
create worktrees or perform automatic branches, commits, merges, stashes, resets,
restores, cleans, or pushes.

## Development

Requires Node.js 22.19 or newer. Pi integration is currently tested against
`@earendil-works/pi-coding-agent` 0.85.1; the peer dependency follows Pi package
conventions and compatibility outside the tested version is not yet guaranteed.

For a local source checkout, install dependencies and build before loading the
package:

```bash
npm install
npm run check
npm run build
pi -e /absolute/path/to/pi-worker-graph
```

After version `0.1.0` is published, install that exact packaged build with:

```bash
pi install npm:pi-worker-graph@0.1.0
```

The npm artifact contains the compiled `dist/` tree. Do not install directly
from Git until the repository has a production-safe build lifecycle for Pi's
`--omit=dev` package installation path.

See [`docs/NEXT.md`](docs/NEXT.md) for current development status,
[`docs/PLAN.md`](docs/PLAN.md) for the implementation sequence, and
[`docs/DESIGN.md`](docs/DESIGN.md) for the proposed runtime contract.

## Security

Pi packages execute with the permissions of the Pi process. Concurrent writable
workers are not sandboxed and can conflict even when tasks appear independent.
Review the source and use the runtime only in checkouts where this operating model
is acceptable. See [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
