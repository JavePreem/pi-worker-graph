# Contributing

Contributions are welcome through issues and pull requests.

## Development

Requirements:

- Node.js 22.19 or newer
- npm

Install dependencies and run the full check suite:

```bash
npm install
npm run check
npm run build
```

Tests use `node:test`. Keep graph-domain tests deterministic and independent of
models, providers, network access, and the Pi runtime. Integration tests must use
fakes unless they are explicitly documented as optional manual checks.

## Design constraints

- Keep the implementation and public API minimal. Avoid speculative abstractions,
  dependencies, configuration, and exports.
- Prefer simplifying or deleting code over adding indirection.
- Validate a complete graph before starting work.
- Keep dependency-edge context explicit and bounded.
- Do not add automatic Git mutations or worktree management.
- Preserve normal Pi behavior until worker-graph mode is explicitly enabled.
- Keep credentials and sensitive repository content out of fixtures and logs.
