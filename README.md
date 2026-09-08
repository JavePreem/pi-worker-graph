# pi-worker-graph

A small DAG-first worker orchestration runtime for the
[Pi coding agent](https://github.com/earendil-works/pi).

`pi-worker-graph` is designed for one orchestrator coordinating multiple writable
workers in a shared checkout. Dependency edges control scheduling and carry
bounded structured context; an optional run-scoped journal is planned for facts
discovered while work is in progress.

## Status

Early implementation. The package currently provides tested graph primitives,
a versioned structured worker-report contract, canonical byte-bounded
prerequisite context, an explicit-root filesystem store, a bounded DAG runner,
a one-shot Pi subprocess adapter, and an explicitly activated parent
orchestration tool. The parent tool is inactive by default; worker children
receive only the final-report tool.

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
    writer: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
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
          profile: "writer",
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

## Orchestrator tool

The extension reads `worker-graph.json` from Pi's agent directory (normally
`~/.pi/agent`). The configuration is byte-bounded, rejects unknown fields, and
requires every worker profile to select its provider, model, thinking level, and
tool allowlist explicitly:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "writer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinkingLevel": "high",
      "tools": ["read", "bash", "edit", "write"]
    }
  }
}
```

Run state defaults to the `worker-graph` subdirectory of Pi's agent directory.
An optional `stateRoot` may be absolute or relative to the agent directory, but
the extension rejects the filesystem root and any path that is inside the target
checkout, including through an existing symlink.

Load the package and activate orchestration explicitly:

```text
/swarm on
/swarm status
/swarm off
```

The `--swarm` extension flag enables the mode at startup. While the mode is off,
the `worker_graph` tool is excluded from the active tool set. While it runs, the
tool streams bounded status and returns deterministic node statuses plus
aggregate usage; worker transcripts never enter the parent model context.

## Planned runtime

The remaining runtime will add:

- retained report artifacts if explicit truncation is added;
- additional child-only coordination tools if required after MVP;
- complete orchestrator-mode tool suppression and session restoration;
- review, repair, and interrupted-run recovery behavior.

Writable workers will intentionally share one checkout. The runtime will not
create worktrees or perform automatic branches, commits, merges, stashes, resets,
restores, cleans, or pushes.

## Development

Requires Node.js 22.19 or newer. Pi integration is currently tested against
`@earendil-works/pi-coding-agent` 0.85.1; the peer dependency follows Pi package
conventions and compatibility outside the tested version is not yet guaranteed.

```bash
npm install
npm run check
npm run build
```

The package can be loaded locally by Pi while the extension is under development:

```bash
pi -e .
```

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
