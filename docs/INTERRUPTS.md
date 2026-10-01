# Interruptible graphs (D24): implementation plan

Status 2026-10-01: **built, measured, and reverted.** It was built in
`eef24ba` and reverted after three cells an arm showed it a regression on
`parso-cluster-20` (D24 in [`DECISIONS.md`](DECISIONS.md) says why). This
page is kept as the record of the plan, what the build settled, and what was
measured; nothing on it describes current behaviour.

## Why

Measured on `parso-cluster-20` (`bench/DESIGN.md` **The restore suite**), third
run: four one-node graphs of luna workers ran in sequence. Each used three or
four repair rounds of 8-11 minutes and failed, 1961/1988 at the 30-minute
limit, while the sol parent sat blocked in `worker_graph`. A repair saw only
the last 2 KiB of the failing check (`CHECK_LIMITS.outputTailBytes`), and the
parent saw nothing until a node failed: it could not tell a converging node
from a stalled one, and every re-plan started blind. Solo sol resolved the same
task for $2.13 in 7 minutes.

The parent could not have read the count even at the end. A failed node's
blockers are its failing-check findings, and the parent's result compacts each
blocker to its first 512 bytes (`MAX_REVIEW_TEXT_BYTES`,
`src/orchestrator.ts:47`): the command, the exit status, and the start of the
2 KiB output tail, a few `FAILED` test names, with pytest's closing
`N failed, M passed` line cut off (checked on
`handoff/restore/cell-parso-cluster-20-graph-luna-3.json`). The repair worker
gets the full 2 KiB. So the result line has to be a field of its own, not a
longer blocker. The per-node table of what the parent did in all four graph
cells is in `bench/DESIGN.md` **What the parent did in the four graph cells**.

What the parent gets today when a graph returns (`src/orchestrator.ts:753`):
node statuses, runtime traces (usage, check outcome, rounds with kind,
duration, blocker count), and each worker's self-written report, labeled
untrusted. Never the worker's transcript. It adapts between graph calls (the
chess and parso parents both re-planned from reports) but never during one.

## What was agreed

1. **Events that reach the parent:** every failed check round, and every node
   that settles. `wait` takes `until: "settled"` to sleep through the rest.
2. **Other nodes keep running** while the parent decides.
3. **Redirect:** allowed only while a node's work or repair round runs;
   refused while it runs its check ("the next round event follows it"). It
   replaces the round it stops, so the check after it counts toward the node's
   `maxRounds` as usual; the check, frozen baseline and review are unchanged.
   At most four redirects per node.
4. **Sessions:** work and repair rounds stay fresh, each with a new session id
   now persisted under the run; only a redirect resumes, and it resumes the
   stopped round's own session. A D20 amendment.
5. **Trace:** one line per tool call (tool, target, failed or not) plus the
   worker's last message; at most 200 calls and 16 KiB; labeled untrusted;
   written once per round as an immutable file under the run.
6. **Framing:** the runtime wraps the parent's text as "The previous attempt
   was stopped. Continue with this assignment:" followed by it. Test the
   wording once against Azure before shipping (see **Pi facts**).
7. **Tool surface:** `worker_graph` returns at the first event; one new tool,
   `worker_graph_control`, with `action`: `wait` (optional
   `until: "settled"`), `inspect` (`taskId`, `round`), `redirect` (`taskId`,
   `assignment`), `abort`.
8. **Settle guard:** while a graph runs the session cannot settle. At Pi's
   `agent_before_settle` boundary the extension appends a message ("Worker
   graph <id> is still running: wait for it, redirect a node, or abort it") and
   requests one continuation. Three consecutive continuations without a control
   call abort the graph. `session_shutdown` aborts a running graph.
9. **Not built:** polling, mid-round steering (Pi `steer`), RPC-mode workers,
   graph mutation (no new nodes or edges; D12 stands).

## Pi facts this relies on (0.99.1)

All from the installed docs
(`node_modules/@earendil-works/pi-coding-agent/docs`) unless marked as
measured.

- A message cannot reach the parent while a tool call runs.
  `pi.sendMessage(..., { deliverAs: "steer" })` is delivered "after the current
  assistant turn finishes executing its tool calls" (`extensions.md:1434`). So
  round events reach the parent only by `worker_graph` or
  `worker_graph_control` returning.
- `agent_before_settle` is "the final actionable boundary: it can append entries
  and request one continuation" (`extensions.md:66`); handlers return
  `continue: true` (`extensions.md:117`), and the docs warn that an
  unconditional continuation can loop. `agent_settled` is notification-only.
  **Unverified:** that the boundary fires in RPC mode, which is how the bench
  drives the parent (`bench/rpc-client.mjs`). Settle it with a unit test on a
  fake and one live cell.
- The JSON stream carries `tool_execution_start` (`toolName`, `args`) and
  `tool_execution_end` (`isError`) per call (`json.md:49`), and since 0.99 opens
  with a `{"type":"session",...}` header, which our parser ignores
  (`src/pi-subprocess.ts:1093`).
- `--session-dir` with `--session-id <id>` opens or creates that session
  (`cli.md:92`). 0.99 creates the session file when the first user message is
  sent (changelog 0.99.0), so even a round stopped before its first reply
  leaves a session.
- **Measured** (probe, 2026-09-30, $0.003 of luna, `docs/NEXT.md`): a worker
  killed mid-`bash` (SIGTERM, then SIGKILL, as `terminateProcessTree` does)
  leaves a session ending on the unanswered call, and a new `-p` run resuming
  the same id with new instructions continues from its history with no
  provider error. Resuming read 1471 of 1547 prompt tokens from the cache
  ($0.000073); forking (`--fork a-1 --session-id a-2`) read none ($0.00041).
  A redirect worded "New instructions from your orchestrator: ..." was cut off
  by Azure's content filter (`Response incomplete: content_filter`); a neutral
  wording passed. Probe scripts: the session scratchpad's `probe/probe2.mjs`
  (not in the repository; reproduce from this description).

## Shapes

Proposed, to be settled in the code; names follow the existing ones.

**Round event**, runtime-authored, queued per graph:

```ts
interface RoundEvent {
  readonly taskId: string;
  readonly kind: "check_failed" | "settled";
  /** 1-based position in the node's `rounds`, the key `inspect` takes. */
  readonly round: number;
  /** Check runs after work so far, against the check's `maxRounds`. */
  readonly checks?: number;
  readonly maxChecks?: number;
  /** Last non-empty line of each failing command, at most 256 bytes each. */
  readonly lines?: readonly string[];
  /** For `settled`: the node's status. */
  readonly status?: "succeeded" | "failed" | "aborted";
  readonly usage: PiWorkerUsage;
}
```

**`worker_graph_control` parameters** (TypeBox, `additionalProperties: false`):

```ts
{
  action: "wait" | "inspect" | "redirect" | "abort",
  until?: "event" | "settled",   // wait only; default "event"
  taskId?: string,               // inspect, redirect
  round?: integer >= 1,          // inspect
  assignment?: string,           // redirect; bounded like an assignment
}
```

Fields an action does not use are refused, the way `parseWorkerGraphRequest`
refuses unknown fields today.

**Results**, text first like `finalText` (`src/orchestrator.ts:753`), with a
`details` object for rendering:

```text
Worker graph running. Run ID: <id>
restore-errors: running (check 2 of 4 failed: 27 failed, 1961 passed)
Events since the last call:
- restore-errors round 5: check failed (2 of 4): 27 failed, 1961 passed
Call worker_graph_control to wait, inspect a round, redirect a node, or abort.
```

Once settled, the existing final text, unchanged, so a graph that settles
before its first event reads exactly as today.

**Round trace**, written once per round:

```ts
interface RoundTrace {
  readonly taskId: string;
  readonly round: number;
  readonly kind: "work" | "repair" | "redirect" | "review";
  readonly stopped?: "redirect" | "abort";
  readonly calls: readonly { tool: string; target?: string; failed: boolean }[];
  readonly omittedCalls?: number;
  readonly lastMessage?: string;
}
```

`inspect` returns it inside the same labeled untrusted block the reports use,
since targets and the last message are worker-authored.

**Session ids**: `work-<sha256(taskId)[0:32]>-<round>`, under
`runSessionDirectory` (`src/store.ts:637`), beside the reviewer's
`review-<digest>` (`src/pi-subprocess.ts:1988`). Pi requires ids to start and
end with a letter or digit (`cli.md`), which this does.

**Redirect framing**, prepended to the parent's text:

```text
The previous attempt was stopped. Continue with this assignment:
```

**Settle message**, appended at `agent_before_settle` while a graph runs:

```text
Worker graph <id> is still running. Call worker_graph_control: wait for its
next event, redirect a node, or abort it.
```

## Edge cases to decide in code, with the proposed answer

- **Parallel tool calls** (Pi may run one message's calls in parallel,
  `extensions.md`): one `wait` at a time; a second `wait` while one is pending
  is refused. `inspect` and `redirect` may run beside a `wait`.
- **Graph settles while the parent is between calls**: the settle is queued
  like any event; the next call returns the final result.
- **Redirect races the round finishing**: if the round's process has already
  exited, refuse with "the round has ended; the next event follows" rather
  than stopping nothing.
- **Redirect and `taskTimeoutMs`**: the node's timeout still bounds the whole
  cycle, redirect rounds included (D20).
- **Redirect and the budget**: `maxGraphCostUsd` counts redirect rounds like
  any other; the budget abort is unchanged.
- **Event queue bound**: at most `RUN_GRAPH_LIMITS.maxTasks` nodes times the
  most rounds a node can run, so a bound falls out of existing limits; still
  cap the queue and say so if it overflows rather than drop silently.
- **Esc during `worker_graph` or `wait`** aborts the graph, as Esc aborts
  `worker_graph` today.
- **`/swarm off` with a graph running** aborts it before restoring tools.
- **A succeeded node's settle wakes the parent.** Agreed (decision 1), but it
  costs a parent turn per node: on the 8-node polyglot fan-out that is up to
  eight returns, at about $0.027 a sol parent turn (parso 3: $0.241 over 9
  turns). `until: "settled"` is the way out, and the prompt guidelines should
  say so.
- **Review rounds** can be inspected but not redirected.

## Changes by file

### `src/check.ts`

- `resultLine(finding)`: the last non-empty line of a failing command's output
  tail, bounded (e.g. 256 bytes). Derived from the finding `runCommand`
  already builds, so no second capture.

### `src/store.ts`

- `publishRoundTrace(stateRoot, runId, taskId, round, trace)` and
  `readRoundTrace(...)`. One file per round under
  `<run>/traces/<sha256(taskId)[0:32]>/<round>.json`, written with the existing
  temporary-file-and-rename path (`writeTemporaryFile`, `src/store.ts:695`) and
  exclusive create, so a trace is immutable once published. Removed with the
  run like `runSessionDirectory` (`src/store.ts:637`). Bounded before write
  (200 calls, 16 KiB).

### `src/pi-subprocess.ts`

- **Trace capture** in `runNormalizedPiWorkerProcess` (`:902`): record each
  `tool_execution_start` as `{ tool, target, failed }`, where target is
  `args.path` or the first 200 characters of `args.command`, and set `failed`
  from the matching `tool_execution_end`. Keep the last assistant text. Hand
  the trace to a callback when the process settles, including on abort and
  failure, so a stopped round still has one.
- **Worker sessions**: a `workerSession(input, round)` beside `reviewSession`
  (`:1988`), id `work-<digest>-<round>`, directory `runSessionDirectory`.
  Work and repair rounds pass it; `--no-session` stays for runs without a run
  directory.
- **Per-round abort**: each work or repair round runs under its own
  `AbortController`, combined with `input.signal`.
- **Redirect**: the cycle (`runPiReviewCycle`, `:1626`) registers a per-node
  control with the executor's options, e.g.
  `onNodeControl?(taskId, { redirect(assignment) })`. `redirect` refuses unless
  a work or repair round is active, or when the node has used four redirects,
  or when the framed payload exceeds `RUN_GRAPH_LIMITS.maxPayloadBytes`.
  Otherwise it stores the assignment and aborts the round's controller. The
  round's rejection is caught; if the abort was the redirect's (not
  `input.signal`), the cycle runs a `redirect` round: the same payload with the
  framed assignment, resuming the stopped round's session, then continues to
  the check exactly as if that round had finished. `PiRoundTrace.kind` gains
  `"redirect"`.
- **Round events**: after every check run, emit
  `{ taskId, round, passed, lines }` through a new `onRoundEvent` option, where
  `lines` are the failing commands' `resultLine`s. The node's terminal
  `notify` (`:1704`) doubles as the settle event.
- **Prompt**: the redirect round's assignment is
  "The previous attempt was stopped. Continue with this assignment:\n\n<text>",
  then the original acceptance criteria and check as today.

### `src/orchestrator.ts`

- **A graph handle** per session: the `executeGraph` promise, an event queue,
  one pending waiter, the node controls from the executor, and the final
  result once settled. Replaces the `graphRunning` flag (`:833`); one graph per
  session still.
- **`worker_graph`**: starts the graph without awaiting it, then waits for the
  first event or settle. Returns the queued events and node statuses; when
  settled, the same final text as today (`finalText`, `:753`).
- **`worker_graph_control`**: TypeBox schema with `action` and the per-action
  fields; `wait`, `inspect` (reads `readRoundTrace`, wraps it in the untrusted
  label the reports use), `redirect` (calls the node control, returns accepted
  or the refusal), `abort`.
- **Signals**: aborting the parent's tool call (Esc) during `worker_graph` or
  `wait` aborts the graph, as today. The budget ceiling (`overBudget`) is
  unchanged.
- **Prompt guidelines**: how to read round lines, when to redirect (a node
  whose failing count stops falling), that a redirect replaces the round, and
  plain wording.

### `src/extension.ts`

- Register `worker_graph_control`, and add it wherever `WORKER_GRAPH_TOOL_NAME`
  enters or leaves the active tool set (`applyTools`, mode off).
- `agent_before_settle`: when a graph is running, append the custom message and
  return `continue: true`; count consecutive continuations and abort the graph
  at three. A control call resets the count.
- `session_shutdown` (`:771`) and `/swarm off` abort a running graph.

## Tests (`node:test`, fakes only)

- Round event after a failed check carries the result line; none after a pass;
  node settle is an event.
- `worker_graph` returns at the first event while the graph keeps running;
  `wait` returns the next event; events that arrive between calls are queued,
  none lost; `until: "settled"` returns the final result.
- `redirect` during a repair round stops it, and the next round resumes the
  same session id with the framed assignment; the check after it counts; the
  refusals (during a check, fifth redirect, oversize payload, unknown task,
  settled node).
- `inspect` returns the stored trace for a round, bounded and labeled; a round
  that was stopped has one.
- Trace files are immutable: a second publish of the same round fails.
- Settle guard: continues while a graph runs, stops once it settles, aborts
  after three turns without a control call; shutdown aborts.
- Existing tests: a one-node graph that settles on its first event still
  returns its final result from `worker_graph`, unchanged. A multi-node graph
  now returns at its first node's settle, so tests in
  `test/orchestrator.test.ts` that expect the whole graph's result from one
  call (the two-node graph at `test/orchestrator.test.ts:176`, for one)
  change to call `wait` with `until: "settled"`; that change in the tests is
  the behaviour change, and should be the only one. `test/extension.test.ts`
  changes only where it asserts the active tool set, which gains
  `worker_graph_control`.

## What the build settled

- **An event's round is the model round its check judged**, the round before
  the check in the node's rounds, so `inspect` takes it as given.
- **A node with neither check nor review is not redirectable.** It runs one
  round, raises no round event, and keeps no session; `redirect` says so. Its
  round still leaves a trace, as round 1.
- **Settle events come from wrapping the executor**, not from progress, so
  they hold for any executor; the status is the one the executor's result
  implies, and a node cut off by its timeout settles failed, as the runner
  records it.
- **Some events do not return.** A node's settle that leaves no other node
  able to run (every other node settled or behind one that did not succeed)
  waits for the result instead, and so does any event of a graph that is
  stopping, by abort or budget. A one-node graph therefore reads as before.
- **Usage is reported once.** Each result's Pi `usage` is what earlier results
  of the graph did not report; `details.usage` stays the graph's total.
- **The guard holds the session while the parent is owed a result**, not only
  while workers run, so a graph that settles between calls is still
  delivered. It continues up to three times without a call to either tool,
  and aborts the graph at the fourth; a cancelled turn (`outcome: "aborted"`)
  aborts at once. An abort appends a message saying so. The guard does not
  read `event.context.canContinue`: at this boundary the context ends on the
  parent's reply, so it is false until the guard's own message is appended
  (`agent-session.js` `_buildBoundaryContext`, Pi 0.99.1). Entries other
  handlers proposed are kept, since Pi chains them.
- **Redirect refusals**: during the check or the review; a fifth; an
  assignment that would take the payload past `maxPayloadBytes`; a settled,
  unstarted, or unknown node. A redirect accepted as its round was ending
  still runs, since the parent was told it would.
- **The bench reads both tools.** `bench/cell.mjs` collects final results from
  `worker_graph` and `worker_graph_control`; the never-started check reads
  final results only.

## Verification after the build

1. `npm run check`, then pack a build into `handoff/builds/` with its hash.
2. One cheap live probe of the framing on Azure luna (item 6), under $0.01.
3. `graph-luna` on `parso-cluster-20` with the new build, $2.25 cap, 30
   minutes, to compare with the third run (1961/1988, $0.769) and solo sol
   ($2.13, resolved). Ask before every paid run.

## What would count as success

Baseline on `parso-cluster-20` (`handoff/restore/INDEX.md`): solo sol resolved
for $2.13 in 7 minutes; the graph's best was 1961/1988 at the 30-minute limit
for $0.769.

- It works if the re-run resolves the task, or ends closer than 1961/1988, and
  the parent redirects at least once on a stalled node rather than waiting for
  it to fail.
- It pays if it resolves at or below $2.13. The time will not match sol's; the
  bench measures cost at equal quality, with time reported.
- It is a regression if `chess-cluster-20`, which resolved for $0.514 without
  it, gets dearer: extra parent turns are the risk, at about $0.027 each.

Prices behind these (Pi's catalog, `azure-openai-responses`, per million
tokens): `gpt-5.6-sol` $4 input, $20 output, $0.40 cache read, $5 cache write;
`gpt-5.6-luna` $0.20, $1.20, $0.02, $0.25. Sol is 20x luna, 16.7x on output.

## Where things stand (2026-10-01)

- D24 built in `eef24ba`. Build for cells:
  `handoff/builds/interrupts-2-2026-10-01.tgz` (hash in `SHA256SUMS`);
  `interrupts-2026-10-01.tgz` has the settle-guard bug below and is not for
  cells.
- **Redirect framing, live** (Azure luna, Pi 0.99.1, $0.0016): a checked
  node's work round was stopped mid-`bash` (`sleep 60`) through its node
  control. The redirect round resumed the same session (one session file,
  the second user message framed), read 3330 tokens from the cache on its
  first turn, passed no content filter, and the node succeeded on its check.
- **Settle guard in RPC mode, live** (luna parent and workers, $0.0034): the
  first probe found the guard aborting every graph, because it read
  `event.context.canContinue`, which is false at this boundary until an entry
  is appended. Fixed, with the guard also keeping earlier handlers' entries.
  Re-run: the parent ended its turn with a node running, the guard held it
  once, the parent called `wait` and received the final result, both nodes
  succeeded.
- **First cells, one each** (`bench/DESIGN.md` **Pi 0.99.1 and D24**):
  parso with D24 timed out (last check 1927/1988, $0.892, 22 parent turns);
  chess with D24 resolved ($0.376, no regression against $0.514); parso on
  0.99.1 without D24 resolved ($0.404, 5 parent turns). Against **What would
  count as success**: it did not work on parso (no resolution, and the one
  redirect went from 168 to 173 failures), and it did not regress chess. One
  cell per arm cannot separate D24 from Pi or from run-to-run spread.
- **What the cells showed about the design.** Events fire at round
  boundaries, so the parent's redirect landed 7 s into the next repair: in
  practice it replaced that repair's assignment rather than interrupting
  work. The extra parent turns cost money ($0.28 on parso), not time; the
  parent spent under a minute of each cell outside the graph tools.
- **Repeats, three cells an arm** (`bench/DESIGN.md` **Repeats,
  2026-10-01**): on parso, without D24 3/3 resolved at $0.404-0.523 in
  18-21 minutes; with D24 2/3 at $0.771-1.418 in 29-34 minutes. The ranges do
  not overlap (p = 0.05 one-sided). With D24 the second node failed every
  time and a third was needed; five redirects, no redirected node passed.
  D24 as built is a regression on parso. Chess says nothing either way.
- **Reverted 2026-10-01**: `src/`, `test/`, `bench/cell.mjs` and the README
  are back at `bb735b5`'s runtime. The builds stay in `handoff/builds/` for
  any re-test.

## Where things stood (2026-09-30)

- Committed through `7afd966`, which holds the bytecode-cache fix
  (`src/check.ts`) and the restore prompt line and grading cache. Uncommitted:
  pi 0.99.1 pins (`package.json`, `package-lock.json`, `bench/bench.mjs:288`),
  README and D14 version text, this documentation and D24, the probe record
  and the `spendSplit` defect in `docs/NEXT.md`, and bench records in
  `bench/DESIGN.md`.
- Every bench cell so far ran on pi 0.85.1; comparisons across the upgrade
  need their cells re-run on 0.99.1.
- Latest build for graph cells:
  `handoff/builds/frozen-bytecode-2-2026-09-30.tgz`; rebuild after this work.
  Raw cell data and the build each used: `handoff/restore/INDEX.md`
  (gitignored). Scripts from the probes and the library screen:
  `handoff/diagnostics/restore-2026-09-30/` (gitignored).
