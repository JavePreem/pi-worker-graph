# pi-worker-graph

A small DAG-first worker orchestration runtime for the
[Pi coding agent](https://github.com/earendil-works/pi).

`pi-worker-graph` is designed for one orchestrator coordinating multiple writable
workers in a shared checkout. Dependency edges control scheduling and carry
bounded structured context; an optional run-scoped journal is planned for facts
discovered while work is in progress.

## Status

Early implementation. The package currently provides tested graph primitives,
an explicit-root filesystem store, and a bounded DAG runner behind an injected
execution function. The included Pi extension entry point is intentionally inert
while real worker execution and opt-in mode integration are developed.

No `/swarm` commands or worker processes are registered yet.

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

## Planned runtime

The remaining runtime will add:

- a real Pi worker execution adapter and worker profiles;
- the versioned structured worker-report contract and retained artifacts;
- Pi-specific state-root resolution outside the target checkout;
- child-only coordination and reporting tools;
- explicit `/swarm on`, `/swarm status`, and `/swarm off` activation;
- configurable worker profiles, models, providers, limits, and state paths;
- cancellation, failure propagation, review, and recovery behavior.

Writable workers will intentionally share one checkout. The runtime will not
create worktrees or perform automatic branches, commits, merges, stashes, resets,
restores, cleans, or pushes.

## Development

Requires Node.js 22.19 or newer.

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
