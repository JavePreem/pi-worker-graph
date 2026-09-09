# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
GitHub Security Advisory page. Do not include credentials, private source code,
or sensitive run artifacts in a public issue.

## Security model

Pi packages execute with the permissions of the Pi process. This project does
not provide a sandbox for workers. Worker subprocesses inherit the parent
environment so Pi can resolve configured provider credentials, and writable tools
can access everything permitted to the parent operating-system user. Task content
is sent over stdin rather than process arguments, but provider requests and tool
activity still handle repository data. Repository `AGENTS.md`/`CLAUDE.md` context
files remain enabled intentionally and must be treated as trusted worker
instructions.

Worker profiles are loaded from the global Pi agent directory, not from the
target checkout. The configuration must not contain provider credentials or
other secrets. Progress projection retains only bounded task status, allowlisted
tool names, and numeric usage; worker messages, tool arguments, tool results, and
stderr are not forwarded into the parent model context. The final result carries
a bounded projection of worker reports inside a labeled block; every `<` in that
serialization is escaped, so worker-authored text cannot close the block and
address the parent as something other than untrusted data.

Run state defaults beneath the global Pi agent directory. Explicit state roots
cannot be the filesystem root or resolve into the target checkout through an
existing symlink; operators should still choose a private, access-controlled
directory outside repositories. Retained runs have a configurable hard count
limit enforced by atomically claimed capacity slots, and reaching it rejects
new work rather than deleting prior state. No elapsed-time heuristic can release
a claimed slot, so a slow creator is never displaced by a second one, and a
published run whose slot is missing stops the store from admitting new work
instead of handing the same free capacity to several creators at once.

Swarm mode removes Pi's built-in `bash`, `edit`, and `write` tools from the
parent tool set and restores the exact pre-mode snapshot on exit. Pi does not
label arbitrary extension tools as read-only or writable, so separately
installed third-party tools remain the operator's responsibility.

Workers are started without a command interpreter: the executable is Pi's own
CLI entry point, resolved through this package's dependency on Pi, and every
argument is passed through `spawn` with `shell: false`. Configured provider and
model values are restricted to a plain-identifier allowlist, and Pi's own
`PI_CODING_AGENT` variable is never treated as proof of what the current process
is, because Pi exports it to everything it launches.

Review the source before installation, use least-privilege credentials, and run
concurrent writable workers only in a checkout where overlapping edits are
acceptable. Process isolation, tool allowlists, and disabled child session
persistence reduce accidental coupling; they are not security boundaries.
