# AGENTS.md

This repository contains reusable Pi meta-tooling: a DAG-first runtime for an
orchestrator and concurrent writable workers.

## Product boundary

- Keep the implementation and public API surface as small as possible. Add only
  code, configuration, dependencies, and exports required by current tested
  behavior; avoid speculative abstractions and compatibility layers.
- Prefer deleting or simplifying code over adding indirection.
- Keep the runtime application-independent. Prefer explicit DAG edges and
  structured node outputs over global prompt injection or semantic-memory
  infrastructure.
- Workers share the target checkout. Do not add automatic worktrees, branches,
  commits, stashes, resets, restores, cleans, or pushes.
- Runtime coordination state belongs outside the target checkout by default.
- Planned activation is explicit; normal Pi behavior must remain unchanged when
  worker-graph mode is off.
- One extension will own worker spawning and graph lifecycle. Do not compose
  competing tools with the same role.

## Safety and concurrency

- Parse and validate the complete graph before starting any worker.
- Reject duplicate IDs, missing dependencies, self-dependencies, and cycles.
- A failed or aborted node blocks its dependents; never run them without required
  prerequisite context.
- Treat file ownership as advisory. Workers must preserve concurrent changes and
  re-read files before editing.
- Store coordination events as immutable files written with a temporary file and
  atomic rename. Avoid concurrent rewrites of one shared document.
- Do not place secrets in prompts, logs, graph state, fixtures, or child-process
  arguments.
- Bound concurrency, task count, output size, runtime, and retained state.

## Development

- Use TypeScript, ESM, and Node.js.
- Prefer plain functions and focused modules.
- Use `node:test` for behavioral tests.
- Test public behavior and observable state rather than implementation details.
- Use TypeBox-compatible schemas for future Pi tools.
- Keep model and provider IDs configurable. Automated tests use fakes and make no
  provider calls.
- Review the applicable Pi documentation before changing integration behavior.

## Working copy

Leave Git lifecycle operations to the maintainer unless explicitly requested.
