# Current development status

## Implemented

The repository now has a small transport-independent core plus an initial Pi
adapter. Automated tests remain provider-free:

- normalized, fully validated DAGs with frozen graph structure;
- deterministic frontiers and guarded node transitions;
- failed and aborted dependency blocking;
- immutable versioned run manifests with opaque task storage keys;
- one bounded retained text artifact per task attempt, published deliberately
  through an optional `worker_graph_report` field, revalidated at every
  boundary it crosses, published before and vouched for by the output that
  references it, kept off dependency edges, named by byte length in the
  parent-facing result, and removed with its run;
- report and prerequisite-context overflow that stay fail-closed rather than
  truncating into an artifact;
- per-attempt token and cost accounting persisted with the attempt, kept for a
  failed, timed-out, or aborted attempt as well as a succeeded one, summed per
  run through `/swarm usage` and `readRunUsage()`, and attributed per task in
  the parent-facing result;
- a reviewed node's attempt naming the reviewer's share of its own figures,
  so a `sol` reviewer beside a `luna` worker is attributable rather than
  fused, absent rather than zeroed when no reviewer ran, and summed into a
  run's total the same way the totals are;
- accounting that keeps zero and unknown apart: absent or unusable telemetry
  leaves an attempt unaccounted rather than free, a run total is only summed
  from outputs that agree with node state, and a task that never ran is
  reported apart from one that ran and recorded nothing;
- parent-owned node state and immutable terminal outputs;
- restrictive permissions and atomic filesystem publication;
- bounded UTF-8 JSON records with explicit read and identity errors;
- an injected asynchronous task-executor interface;
- a strict versioned structured worker-report contract;
- defensive report validation and immutable JSON snapshots;
- normalized repository-relative changed-file paths and bounded diagnostics;
- blocker-bearing report failure with retained parent-visible output;
- bounded concurrent DAG execution with deterministic frontier selection;
- durable terminal output before dependent activation;
- direct-prerequisite-only output propagation;
- deterministic task-ordered prerequisite report serialization;
- named JSON report blocks with explicit untrusted-data labeling;
- exact UTF-8 context accounting and fail-without-truncation overflow behavior;
- explicit provider/model/thinking/tool worker profiles with no model defaults;
- one-shot Pi JSON-mode subprocess workers in the target checkout;
- task delivery over stdin rather than child-process arguments;
- child isolation from discovered extensions, skills, prompt templates, and sessions;
- a child-only terminating structured final-report tool, with recoverable
  rejection so a worker can correct and resubmit a report;
- enforcement that the report really was the worker's final action, covering
  Pi's parallel tool batches;
- positive identification of Pi's executable, with no shell on any platform;
- event-stream framing bounds that skip unparseable lines instead of failing a
  worker whose transcript is legitimately large;
- allowlisted adapter failure diagnostics, surfaced through one pre-run error
  type and one execution failure type;
- process-group cancellation with forced termination fallback and post-exit
  collection of orphaned grandchildren;
- sanitized executor failures, cancellation, and task timeouts;
- task, dependency, concurrency, payload, output, and context limits, with a
  per-task runtime ceiling of 30 minutes kept apart from the 10-minute default
  a caller gets when it asks for nothing, so a slow-building repository can be
  given more time by an orchestrator that may only lower what it is handed, and
  named in the tool's schema and guidelines because one timeout covers a whole
  node -- the worker and every review and repair round on it;
- bounded, redacted worker progress projection and aggregate usage accounting;
- a strict global `worker-graph.json` profile configuration;
- a default state root beneath Pi's agent directory, with checkout-local roots
  rejected by the extension;
- one static, fully bounded `worker_graph` parent tool;
- explicit `/swarm on`, `/swarm status`, `/swarm off`, `/swarm usage`,
  `/swarm runs`, `/swarm delete`, and `--swarm` activation;
- an optional configured orchestrator session model and thinking level, applied
  on activation and restored on exit, refused unless the mode knows the
  identifiers that restore it, the model is one Pi can find, and its provider
  is authenticated, with a model the configuration stopped naming still put
  back and a restore that cannot be performed reported rather than swallowed;
- session-persisted swarm mode with exact active-tool restoration and built-in
  parent mutation tools suppressed while active, with branch-recorded state
  governing session-tree navigation and activation refused for any tool set the
  extension could not restore;
- compact, explicitly bounded worker-report projection for parent review and
  focused follow-up graphs, delivered in a labeled block worker text cannot
  close;
- a configurable retained-run cap enforced by atomically claimed capacity slots,
  with deterministic arbitration between concurrent creators, no implicit
  deletion, stranded slots reported for explicit removal, and inconsistent
  run/slot state failing closed;
- explicit retention cleanup through `/swarm runs` and `/swarm delete`: a
  listing of everything holding capacity, and deletion of a named run with its
  slot, refused while an orchestrator holds the run and ordered so an
  interruption can only strand a slot;
- an operator release of a hold whose orchestrator is gone, through `/swarm
  release`: the hold is given up and the run kept, an owner record no caller
  could validate is removed rather than parsed, a mutation in flight refuses
  the release as evidence of a live writer, and nothing reclaims a hold on
  elapsed time;
- a reviewer told how to read a checkout other workers are changing: a modified
  file outside the assignment is not evidence about the work under review, and
  another worker's change is never a finding and never to be reverted;
- an optional per-node work-review-repair cycle: a reviewer profile judges the
  worker's result against the assignment, its blockers become the repair
  worker's instructions, and the cycle repeats until a reviewer accepts or the
  round limit is reached, with a still-rejected node failing rather than
  publishing work review refused, every round's spend summed into the node's one
  attempt, and the graph left frozen because rounds are not nodes;
- an optional per-node check (D23): shell commands the runtime runs itself from
  the checkout root after the worker reports, repairing on failure with a
  bounded output tail, before any review; run once before the worker to show
  it can judge the task (`before: "fail"` by default, or `"pass"` for
  behaviour to keep), with `frozen` paths fingerprinted before the worker and
  after every round so a worker cannot pass the check by editing its tests,
  and a runtime-authored trace of how it went (`failingBefore`, `runs`,
  `outcome`) on the node's terminal event and parent-facing result;
- configured worker profile names carried to the parent in the request while
  the mode is enabled, prepended by a `context` handler so registration stays
  static, the transcript keeps no copy, and `/swarm off` drops the block from
  the next request, read again per request so the names cannot diverge from the
  configuration the tool validates against, marked read-only only for a profile
  holding no tool that can change the checkout, and bounded by the
  configuration parser rather than by shortening a name the model must type
  exactly;
- immutable bounded run-scoped coordination events and directed inbox messages,
  in one run-global journal, with cursor-based queries and child-only Pi tools;
- a run mutation lock that names its holder, so contention between the parent
  and a publishing worker is reported apart from an ownership conflict, waited
  out rather than resolved by force, and recovered only when the lock names a
  task the graph runner knows has finished;
- coordination cursors that run past records a reader is never given, so
  polling costs only the records published since the previous call;
- a verified npm artifact containing the compiled runtime, loaded from a clean
  temporary install in offline Pi RPC mode;
- behavioral coverage using `node:test`, fakes, and temporary directories.

Normal parent sessions register the `/swarm` control command, but the
`worker_graph` tool is inactive until explicitly enabled. The report tool is
registered only inside explicitly marked worker children. Active graph
lifecycles claim an exclusive owner before mutating run state; resumable or
externally addressable runs are not implemented yet.

## Verify the baseline

```bash
npm install
npm run check
npm run build
cp docs/worker-graph.example.json ~/.pi/agent/worker-graph.json
pi -e .
```

`npm run check` currently runs the adapter, configuration, context, extension,
graph, orchestrator, report, store, and runner suites, and the bench RPC-client
suite under `bench/`. `npm run build` must run before `pi -e .`, because
`extensions/index.ts` re-exports the compiled entry point from `dist/`. The configuration copy is required rather than optional:
the extension has no provider or model defaults, and `/swarm runs` and
`/swarm delete` resolve the state root through the same file, so a missing
`worker-graph.json` answers both subcommands with a configuration error.
Loading the package in Pi adds the `/swarm` control command, whose `runs` and
`delete` subcommands work whether or not the mode is enabled, but leaves the
parent tool set unchanged. The entry point registers
the worker report tool only when `PI_WORKER_GRAPH_ROLE=worker`, which the
parent sets on worker subprocesses and never on its own session. Active graph
lifecycles claim an exclusive owner record before mutating run state; resumable
or externally addressable runs are not implemented yet.

## Next implementation slice

Items 1, 3 and 5 of the previous slice were verified live against Pi 0.85.1
driven headlessly in `--mode rpc`, with a throwaway agent directory supplied
through `PI_CODING_AGENT_DIR`. They are recorded here in summary rather than at
length:

- a provider-backed smoke test — two independent workers and a dependent
  validation node, real Pi subprocesses — succeeded in 22.7s. Each worker
  changed only its own file, the validation node received both prerequisite
  reports, run usage summed with nothing unaccounted, and the store kept mode
  `0700`;
- the `/swarm` command surface behaved as specified: usage text, `status`,
  `on`/`off`/repeat-`on`, `runs`, `usage <id>`, `delete <id>`, and every
  bad-argument path. `ctx.cwd` was confirmed as the working directory by
  pointing a state root inside the checkout and getting the checkout-local
  refusal;
- a configured orchestrator profile moved the parent from `gpt-5-mini` to
  `gpt-5` on `/swarm on` and back on `/swarm off`, against a real provider
  catalogue and real authentication. The shutdown restore lands: in a persisted
  session the entries run model change to the orchestrator model, the mode
  record carrying `modelBeforeMode`, then a model change back at
  `session_shutdown`. Pi awaits the handler on the graceful path, and RPC mode
  disposes the runtime host the same way interactive mode does. It is not
  awaited on `emergencyTerminalExit` or `uncaughtCrash`, where the terminal is
  already gone.

The profile-discovery gap that preceded the prerelease is closed (D21): the
configured names now reach the parent in the request while the mode is enabled,
so an orchestrated run no longer needs an out-of-band patch naming them. It is
covered by the automated suites. It is deliberately not being confirmed in a
one-off live session: the bench exercises the same path under measurement, and
a hand-run session would only tell us what the bench is built to tell us
properly.

`0.1.0-dev.2` is published and tagged, carrying the reviewer attribution fix,
the `/swarm release` operator act, the narrowed `~0.85.1` peer range, and a CI
matrix green on Node 22 and 24.

It was smoke-tested as a user gets it: installed from npm into an empty agent
directory, then a real three-node graph over three Pi subprocesses through
`bench/rpc-client.mjs`. Neither earlier check covered that combination — real
workers had only run from the checkout, and the artifact had only been loaded
offline. Everything mechanical held, down to the store at `0700` outside the
checkout with no git operation run.

The graph failed, and that was the trial's value. Both workers made exactly
their assigned edit; each node's reviewer then saw the other worker's file
modified and rejected on the criterion that no other file be changed, with
blockers asking for the sibling's work to be reverted. A reviewer is a worker
child and already carried the shared concurrency contract, but that text is
written for a worker doing work, not one reading a diff. The attribution rule
is now stated in `reviewPayload` (`src/pi-subprocess.ts`).
Re-run after the fix: all three nodes succeeded, `unaccounted` empty.

What remains, in order:

1. Work the Phase 8 bench queue. `bench/DESIGN.md` carries the design and
   `bench/DESIGN.md` "What carries over" now says which parts exist. The
   harness is built and covered by `npm run test:bench` against fakes:
   containers and the in-container toolchain, Tier-1 grading from recorded
   fail-to-pass targets, the queue and its append-only store, preconditions,
   and paired analysis with the spend split. What is not built is the Tier-2
   judge, which is only worth having once the spend split says there is a
   saving to defend.

   The harness is suite-agnostic: ProMax lives in `bench/suites/promax/`, and
   a second suite, `polyglot` (Aider's polyglot exercises, three to a task,
   visible read-only tests), is built and self-tested 27/27 at no provider
   spend.
   At three a bundle it does not separate `sol` from `luna`: 6/6 bundles
   resolved by both solo arms. The work is finding a suite that meets
   `bench/DESIGN.md` **What a suite must satisfy**: luna fails where sol
   resolves, the work is large against the ~$0.08 per-session sol overhead,
   and it decomposes.

   **Polyglot at twenty a bundle separates them, on too few tasks.**
   `BENCH_BUNDLE_SIZE=20` cuts the two languages into three bundles (20 and
   29 JavaScript exercises, 34 Python). `solo-sol` resolved all three at
   $0.83-0.97 each; `solo-luna` failed all three, passing 19/20, 11/29 and
   11/34, and ended every session with tests still failing. That is
   criterion 1 met on the whole pool, and a pool of three. The pinned
   repository has 225 exercises in six languages; the image runs two.
   `bench/DESIGN.md` **The polyglot suite**.

   Two harness fixes came out of it. A session whose final turn the provider
   errored -- sol cut off by `content_filter`, seen live -- is now classed
   `not-attempted` (`provider-error`) rather than graded as the arm failing
   the task. And the prompt now says to run an exercise's tests from its own
   directory, where grading runs them; from the checkout root the JavaScript
   specs do not transform, and luna spent turns on that.

   **ProMax is set aside as too hard.** Top models resolve about 41% of it, so
   the strong arm fails most tasks and luna-fails/sol-resolves pairs are rare
   by construction. What its screen found is kept below. It ran one cell
   at a time, luna first, sol only where luna fails. The hidden tests graded a
   guess on both instances both arms ran, and the grader scored a conflict
   whenever an agent edited a file `test_patch` touches, even identically --
   which is what the unexplained conflicts below were. Both are fixed:
   `prepare` commits the tests before the agent starts and the graded targets
   follow the statement, and grading restores those files first. First
   reading: luna resolves `c_b8f2a50` and `c_9f44b41` with the tests
   visible, and fails `c_e3dcf52` and `c_768a09d`. Sol "resolved" both of
   those by copying the upstream fix out of the image's git history: every
   image checked carries its fix commit, reachable from `git log --all`.
   **Criterion 1 is unmeasured until `prepare` strips that history.** `bench/DESIGN.md` **Why ProMax's tests are visible**.

   The Angular subset is swept in full: 25 of 25 validated, 23 with a
   fail-to-pass set. **The pool is settled at 23.** The 3 ant-design instances
   are out by decision, recorded in `bench/suites/promax/excluded-instances.json` and argued
   in `bench/DESIGN.md` "Why the ant-design three are out": they buy three
   points of power, they do not make the pilot any less an Angular benchmark,
   the largest of them would be graded by a snapshot oracle over a class rename
   the problem statement names, and a second grading path would make any
   difference on those three unattributable. `bench/bench.mjs init` therefore
   needs no `--partial-pool`.

   The grading path is no longer the open question.
   `bench/selftest.mjs --suite promax` has proven it on 6 of 23 instances, all resolved
   at no provider spend, and the five after the first were picked to cover
   every multi-target shape in the pool -- 54 of its 78 targets, and the first
   exercise `resolveTier1`'s regression branch has had. The other 17 are
   single-target instances of a shape already proven, so what is left there is
   breadth rather than an unrun code path, and it does not block a cell.

   **The harness path is proven live.** A `solo-luna` cell ran end to end on
   `azure-openai-responses` through `bench/bench.mjs cell <id> <arm> --cap
   <usd>`, which runs one chosen cell outside the queue and writes no record:
   Pi installed from the throwaway agent directory inside a container confined
   to the provider's endpoint, 21 turns, 20 tool calls, a two-file diff, graded
   unresolved on a target that still failed to build, credentials scrubbed
   before grading, nothing left behind. 190s and **$0.016** -- a twentieth of
   the $0.08-0.31 estimated for that arm, because 91% of its tokens were cache
   reads priced at a tenth of input. `bench/DESIGN.md` carries the split and
   the reasons not to generalise from one cell.

   Running it found two harness faults, each of which would have been recorded
   as the cheap model failing the task. The ProMax images carry their builder's
   unreachable proxy, which silently disables every provider. And
   `--cap-drop ALL` removes `CAP_DAC_OVERRIDE`, so the container's own root
   could not read the `0600` credentials `docker cp` left owned by the host
   UID; Pi reported that as `Model not found`.

   **The package path is proven too.** A `graph-luna` cell ran end to end:
   four `worker_graph` calls, workers that did 169 turns between them, two
   reviewed nodes, a four-file diff, graded unresolved. $1.39 and 20 minutes.
   Getting there took two fixes -- `pi` was not on PATH in the container, so
   every worker failed to spawn, and a cell whose workers never start is now
   classed `not-attempted` rather than scored as the arm failing the task.

   Three findings came out of it, in `bench/DESIGN.md` under **Measured**. The
   orchestrator never fanned out: every graph held one task, which is what
   killed the first fixture suite and is now evidence for open decision 4.
   The spend split ran for the first time at 73.65% node share -- and it had
   never worked before, because the parser expected a JSON document where the
   tool emits prose wrapping a tagged block. And a node's cost blends worker
   with reviewer and cannot be separated, which promotes the no-review arm
   from an extension to the thing needed to attribute the saving at all.

   It takes **two** cells, not one, and the package is what the second buys.
   A solo arm gets no `worker-graph.json` and no package tree --
   `workerGraphConfig` returns undefined when an arm has no machinery
   (`bench/arms.mjs`), and `makeAgentDirectory` then writes neither
   (`bench/toolchain.mjs`) -- so there is no `/swarm on` in a `solo-luna` cell
   to verify. `/swarm on`, the worker profiles, the subprocess workers and the
   review cycle remain covered only by the automated suites against fakes.

   The package path needs a `graph` arm, and the cheapest is `graph-luna` at
   $1.28-5.11: both graph arms run a `sol` parent and a `sol` reviewer, so the
   worker is the only difference between them and `graph-luna`'s is `luna`. Run both before
   `init`: about $1.36-5.42 against $17-67 for the twelve, and if the graph
   cell fails the twelve would have failed with it.

   The bench runs on `azure-openai-responses` rather than the agent
   directory's `github-copilot` default, because the cost claim needs per-token
   billing against a nameable rate card; `init` records the choice and every
   later run is refused if it resolves to a different one.

   **Fan-out was bought, and it half-answered.** Three `graph-luna` trials ran
   on 2026-09-21, on the three largest gold patches in the pool, $5.86 for the
   three; `bench/DESIGN.md` **Fan-out, measured** carries the table. One cell
   decomposed -- eight `worker_graph` calls, two of them three-task graphs --
   and met its preconditions. One took five tasks one at a time and failed on
   "no graph had more than one task". The third never reached a provider: that
   image's Node predates an API Pi imports, so Pi would not start, and the cell
   was classed `not-attempted`.

   So a graph does decompose, at roughly one cell in two on the shapes most
   likely to provoke it. That is enough to stop the economics question being
   moot and not enough to buy twelve cells on: half the treatment cells would
   carry no treatment. Open decision 4 -- whether the `graph` arms get extra
   orchestrator guidance on fan-out -- is now the thing in front of `init`, and
   it is a decision rather than another purchase.

   Three things the run turned up, before the queue is opened:

   - **The reviewer took 72.6% and 84.5% of node spend.** Read from the
     `usage.review` the package now reports. A `luna` worker under a `sol`
     reviewer may not be a cheap arm at all, which is the headline the spend
     split exists to produce and is now visible on two cells.
   - **Neither graded cell ran a target**; both stopped at
     `test-patch-conflict`. Part is the documented reading -- the agent edited
     a test file the patch touches -- and part is unexplained, and cannot be
     read back because `applyPatch` keeps only the last 400 bytes of stderr
     (`bench/container.mjs:256`). Widen that before buying a graded cell.
   - **Workers are hitting the 10-minute task ceiling** (`src/run.ts:62`), 3 of
     17 tasks across the two cells, and an arm cannot raise it.

   All three are addressed. The failing targets' Bazel output and the files
   `git apply` refused are now kept with the cell rather than dropped
   (`bench/cell.mjs`, `bench/container.mjs`); the runtime ceiling and its
   default are separate figures, 30 minutes and 10; and every arm now gets a
   fixed preamble naming the checkout and the build command -- since reworded
   for visible tests -- `bench/DESIGN.md` **The prompt every
   arm gets**, with its hash in the manifest so a reworded run cannot be pooled
   with this one.

   Both `solo` arms then ran on the rig under that preamble, and both now build
   and verify before finishing -- the failure mode where an agent shipped an
   uncompiled edit is closed. Neither resolved: `solo-luna` at $0.018 and
   `solo-sol` at $0.375 made the same semantic choice on the same line, and the
   graded test wanted the other one. `bench/DESIGN.md` **The rig, and what the
   preamble bought**, and the matching threat to validity: a hidden test can
   encode a convention the problem statement does not. No prompting fixes
   that; making the tests visible does, and ProMax now does.

   **Seven images could not run Pi, and now can.** A `node --version` probe per
   image, at no provider spend, was stopped at 15 of 23 for host memory, and 7
   of those 15 carry Node 18 or 20 -- below what Pi 0.85.1 needs, so a cell on
   them was not attempted at all. The toolchain now carries a pinned Node and
   runs Pi under it through a shim, deliberately off PATH so the image's own
   Node still serves the Bazel build. Proven live on the worst case:
   `bench/DESIGN.md` **Not every image can run Pi**. The pool stays at 22.

   **Measured since: a checked graph beats solo sol on polyglot, and costs
   more than it on cold start.** Details in `bench/DESIGN.md` **The polyglot
   suite** and **The cold-start suite**.

   - `graph-luna` on the 29-exercise JavaScript bundle resolved it twice. On
     the published `0.1.0-dev.2` it cost $1.16 (sol $0.83): the parent read
     all 58 specs, made three graphs, and sol reviewers re-judged tested work.
     With the node check and leaner parent guidance (D23) it cost $0.21 in
     one graph of eight checked luna nodes. Earlier graph cells ran the
     published package: `--package-spec` defaults to `pi-worker-graph@latest`,
     so a local build needs an `npm pack` tarball passed explicitly.
   - A third suite, `coldstart`, gives only a specification and a contract and
     asks for the implementation and its tests. It grades hidden compliance
     cases, and records the agent's tests against a reference (validity) and
     40 mutants (strength). On `jmespath`: solo luna 490/891 hidden, no tests,
     $0.03; solo sol 862/891, 17 tests, 31/40 mutants, $0.67; `graph-luna`
     875/891, 69 tests, 33/40 mutants, $3.08 -- stopped by the $3 cap, graded
     by hand from its diff. $2.51 of it was sol review rounds. The parent made
     five one-node graphs and let each worker write the tests its own check
     ran: reviewer-driven repair, not tests-first.

   **Theories for a cheaper graph, from that `jmespath` cell.** Unverified;
   each names the data it rests on and the cell that would test it.

   | node (one per graph) | worker | review | review turns | review cache writes |
   | --- | --- | --- | --- | --- |
   | implement-jmespath | $0.044, 41 turns | $0.618 | 10 | 53k tokens |
   | repair-projections-and-conformance | $0.035, 37 turns | $0.637 | 11 | 51k |
   | repair-final-conformance | $0.050, 59 turns | $0.696 | 11 | 59k |
   | structural-projection-rewrite | $0.018, 19 turns | none | -- | -- |
   | broad-conformance-tests-audit | $0.035, 36 turns | $0.561 | 14 | 57k |

   The parent spent the remaining ~$0.39 across 13 reads and five graph calls.
   The hidden score was 875/891 both after the fourth node and at the end.

   - **T1. Every round starts cold.** Each review round is a fresh sol process
     that re-reads the 2,070-line specification and the code: about 55k tokens
     written to cache per node, about $0.30 a round, against $0.02-0.05 for
     all of a node's luna work. The cost is re-acquiring context, not judging.
     D20 chose fresh rounds over resumed sessions; this is its price. Test:
     the same cell with the reviewer handed the relevant specification
     sections instead of the whole document, or one reviewer session kept
     across a node's rounds.
   - **T2. Review findings are tests written in prose.** The blockers were
     concrete cases -- `foo[*].bar[0]` over a given document "must return
     `[1]`", `!a == b` must parse as `!(a == b)`. Written as executable
     tests in a frozen file instead, every later round is judged by the
     node's check for nothing, and a fix cannot silently regress. Sol then
     pays once per defect found, not once per round. Test: a reviewer that
     writes failing tests into the checked, frozen suite instead of blockers.
   - **T3. A check that runs the worker's own tests accepts nothing.** Every
     reviewed node's check passed (`runs: 2, outcome: passed`) while the
     reviewer rejected it: the worker wrote both code and tests, so they
     agreed. `before: "fail"` held trivially on the first node because no
     tests existed and pytest exits non-zero when it collects nothing. Test:
     tests-first -- a node writes the tests, frozen, before the
     implementation nodes that are checked against them. It needs a writable
     strong profile (item 1 below). A check failing because nothing ran should
     probably not count as failing for the right reason.
   - **T4. One node per graph turns the parent into the repair loop.** All
     five graphs held one node covering the whole package, so nothing ran in
     parallel, every review re-read everything, and each repair cost a parent
     round-trip (reads, a new graph) where the node's own repair rounds would
     have done. It took 34 minutes against solo sol's 4. Test: guidance to
     split by specification area behind an interface-first node, and to
     raise `maxRounds` rather than re-plan.
   - **T5. Review is dearest where it adds least.** The one node without a
     review fixed projections for $0.02. The last node, a tests audit,
     cost $0.60 and moved the hidden score not at all (875 before and after),
     though it grew the suite from about six test functions to 69. Where the
     hidden cases already pass, a review buys test coverage at sol prices.
   - **T6. The measured lift may be a second look, not delegation.** Luna
     under sol review beat sol alone, but sol alone had one pass. A single
     session that is asked to refine keeps its context warm, where cached
     tokens cost about a tenth of fresh ones. Test: `solo-sol` with "refine"
     sent twice in the same session; if it reaches ~875 for under $3.08, that
     is the baseline a graph arm has to beat, not plain `solo-sol`.

   The cell cannot attribute its score to a stage: the hidden cases were only
   run on a snapshot and on the final diff. Grading the checkout after every
   `worker_graph` call, off the container, would say which rounds bought
   what.

   **Limitations and caveats on everything above.** Read these before
   drawing on the numbers:

   - **One cell per arm, one task.** No figure has a variance. Sol's 862 and
     the graph's 875 differ by 13 of 891 cases; a rerun of either could close
     that. The polyglot $0.21 is one cell on a bundle picked because it
     separates the arms.
   - **The graph's cold-start grade is hand-made.** Its record says
     `not-attempted (spend-cap)`. The grade applies the recorded diff to an
     empty checkout and runs the hidden cases on the host (Python 3.12; the
     image has 3.11) and the test-quality layers in the image. The diff is
     the checkout at the moment the cap stopped the parent, which may have
     been about to plan a sixth graph: it neither shows the graph's ceiling
     nor excludes a regression.
   - **Strength is coarse.** 40 mutants, one seeded draw of operator and
     constant changes; one mutant is 2.5 points, so 31 against 33 is not a
     difference. Validity depends on the reference, which drops the cases it
     fails (1 JMESPath, 1 Mustache, 4 JSONPath).
   - **"Hidden" is partly visible.** `specification.rst` carries worked
     examples, and the compliance suite overlaps them. JMESPath is also a
     well-known specification whose Python reference shares the contract's
     module name, so recall may help every arm.
   - **The cost split is partly inferred.** Node and reviewer figures come
     from the package's own accounting; the parent's ~$0.39 is the session
     total minus them. The cause in T1 -- context re-acquired per round --
     is read from cache-write volumes, not measured by changing it.
   - **The graph arm measured the bench's configuration, not the package's
     limit.** Only a luna `worker` and a read-only sol `reviewer` exist, so
     the parent could not have put sol on a writing node, and the settle
     limit (45 minutes) was far looser than the task needed.
   - **The build is not identifiable from these records.** A local tarball
     carries the published version string, so which build a record measured
     is known only from these notes. The tarballs themselves are kept, with
     their hashes, in the gitignored `handoff/builds/`, and
     `handoff/coldstart/INDEX.md` maps each cell to its build and raw files.
     Records made from now on name the build: `packageVersion` carries the
     tarball's npm integrity after the version (`bench/bench.mjs`
     `packageLabel`).
   - **Two of three cold-start tasks are unrun.** Mustache and JSONPath have
     passed the self-test only; nothing says JMESPath is typical.
   - **The theories were written after seeing the data they explain.** Each
     needs its own cell before it steers a design change.

   **Measured 2026-09-29: tests-first is cheap and capped by its tests; refine
   buys nothing.** Both on `jmespath`, harness-graded, one cell each, same
   build as the cell above (`handoff/coldstart/INDEX.md`).

   | arm | hidden | cost | wall | own tests | valid on reference | mutants killed |
   | --- | --- | --- | --- | --- | --- | --- |
   | `solo-sol` (2026-09-28) | 862/891 | $0.67 | 4 min | 17 | 13/17 | 31/40 |
   | `solo-sol-refine` | 862/891 | $1.07 | 6.7 min | 12 | 6/12 | 17/40 |
   | `graph-luna` (2026-09-28) | 875/891 | $3.08 | 34 min | 69 | 63/69 | 33/40 |
   | `graph-luna-tests-first` | 790/891 | $0.93 | 15 min, timeout | 131 | 120/131 | 35/40 |

   What the failures say, from every cell's diff regraded with no cap on
   the failures kept (the record keeps five per area):

   - **Each arm's losses are mostly one bug.**
     - Tests-first: 78 of 101. The parser accepts only an identifier after
       `.`, but the grammar's `sub-expression` (`specification.rst:258`) also
       allows `*`, a multi-select list or hash, and a function
       (`foo.*.baz`, `foo.{a: a}`, `foo.[a, b]`, `a[].to_string(@)`).
     - Solo sol: about 20 of 29. A projection after a flatten, as in
       `a[].b[].c`, nests instead of continuing the projection.
     - Graph-luna: 16 failures, spread out, with no dominant cause.
   - **Tests-first: the tests decided the score.** None of the 131 tests uses
     any of those forms. Luna passed every frozen check in its first round,
     so no check round was spent and nothing looked beyond the tests. Three
     hidden failures come straight from tests that are wrong against the
     reference (`@.foo` asserted a `ParseError`, and the raw string `'\\'`).
     A further 8 are slice projections the tests never exercised.
   - **The spec's worked examples would not have covered the gap.** No
     `search(...)` example in the specification uses `.*`, `.{` or `.[`; only
     the grammar has them. Tests transcribed from the examples would have
     missed the same 78.
   - **Parallel area nodes were not available.** All four luna nodes changed
     `parser.py` and `evaluator.py`. The parent's serial chain matches the
     package's own serialization rule for one function redesigned by several
     tasks. The four took 11 minutes and 91 luna turns in all, for $0.09;
     per-node timing is not in the record.
   - **Refine re-read nothing.** The two follow-up turns made 4 and 8 spot
     edits without opening the specification again, for about $0.4. They
     traded three syntax cases for three others and left the flatten bug in
     place.
   - **Yesterday's graph found semantic bugs through a sol reviewer reading
     spec and code.** That is the one step neither run today had, and the one
     that cost $2.51.
   - **The tests-first spend is under-reported.** The session total ($0.93)
     omits the audit node the timeout killed, because a worker's usage reaches
     the parent only when its graph returns.
   - `solo-luna` is 490/891 on its record and on regrade. The 553 quoted
     earlier had no source and is corrected.

   Conclusion: on this task, hidden quality follows whatever last judged the
   work against the specification. With tests-first that is the tests, and
   the tests missed a grammar production. The mechanism is cheap ($0.09 of
   luna did the implementation to the tests), but its ceiling is set by the
   test author. One cell per arm, one task; none of this has a variance.

   Since then:

   - Every failing hidden case is kept in the record (`runner.py`,
     `targetStates`), so the analysis above no longer needs a regrade. The
     reference still grades resolved on `jmespath`.
   - A stopped cell sends Pi `abort` and re-reads the spend before killing
     anything (`bench/cell.mjs` `abortSession`). An aborted graph's result
     carries its in-flight workers' usage (`aggregateUsage`), and Pi adds it to
     its session stats after an abort. Verified live on `graph-luna` v2 (below).
   - `graph-luna-tests-reviewed` is `graph-luna-tests-first` plus one change:
     a sol review (2 rounds) of the tests node against the specification.

   **Measured 2026-09-29: the review closed the coverage gap, and the cap cut
   the cell off before any implementation.** The $1.50 cap was reached at 6.8
   minutes, with only the tests and the stub written (0/891).

   - **Tests node: $1.32**, against $0.55 unreviewed. That is $0.82 for the
     author over a work round and a repair round, and $0.49 for two sol review
     rounds. The parent spent $0.19.
   - **The review found the gap that cost 78 cases.** Its first-round
     finding was the missing `expression "." "*"` form; the repaired suite
     uses `foo.*`, `outer.{...}` and `outer.[...]`. There are 267 tests, 38/40
     mutants killed, the best of any cell.
   - **Validity did not move.** 11 of the 267 tests fail on the reference, as
     11 of 131 did before, mostly on the same points: the raw string `'\\'`,
     `merge()`, ordering non-numbers, a zero slice step, `` `not json` `` and
     `ceil` on a string. The review's "agrees with the specification" does
     not catch them. They look like places where the specification's text
     and the reference differ; the hidden suite follows the reference.
   - **The guidance had a bug.** It gave the tests check no `maxRounds`, so
     the first graph call failed validation ($0.02, 10 s). Fixed: the
     guidance now gives it `maxRounds 2` (`bench/arms.mjs` `testsFirst`).
   - **Abort worked live.** The parent's last message ended `aborted`, and the
     spend read after the abort includes the tests node. No worker was
     running at the stop; in-flight accounting was verified later, on
     `graph-luna` v2.
   - The cap was sized wrong, not the arm. Both review rounds plus the
     author's repair came to about $1.70 before any luna work, above the cap.

   **Reviewer sessions resume across rounds (D20 amended).** A node's
   reviewer now runs every round in one Pi session under the run's directory
   (`--session-dir <run>/sessions --session-id review-<hash>`); work and
   repair rounds stay `--no-session`. From Pi's code: json mode replays no
   history (`print-mode.js`), and a resumed session keeps its id, which Pi
   sends as `prompt_cache_key`. Verified live with a Pi-only probe on luna
   (2026-09-29, $0.002). Run 1 read a 20 KB file and wrote 5,811 tokens to
   the cache. Run 2 was a new process resuming the same id, and its first turn
   read those 5,811 tokens from the cache and wrote 19. That turn cost
   $0.00013, against $0.00146 for the same context uncached. The session id
   was the same on both runs.

   **Review-round guidance follows the resumed sessions.** The parent was told
   "two is usually enough" (`src/orchestrator.ts`). On `graph-luna` all four
   reviewed nodes ran out of two rounds with real findings still open. Three
   of its five graphs just continued the node before, each paying a cold
   reviewer and about $0.08 of parent turns. Now that later rounds are warm,
   the guidance prefers three or four rounds up front for work judged against
   a long specification. The saving is unmeasured; estimated at $0.4-0.6 on
   that cell.

   **Each node now reports its wall-clock and its rounds.** Every node's
   entry in the parent's result carries `durationMs`. A checked or reviewed
   node also carries `rounds`: each `check_before`, work, check, review, and
   repair step in order, with its own duration, usage, and open blockers. The
   per-round splits above had to be inferred from cache-write spikes; these
   make them direct. Rounds are dropped before the report when the result is
   short of room.

   **Measured 2026-09-29: `graph-luna` on the new build costs half as much and
   ran out of time.** Two cells were run on `jmespath` with
   `review-sessions-traces-budget-2026-09-29.tgz`, a $2 cap and 30 minutes.
   The first was degenerate: the parent's only turn was "I'm sorry, but I
   can't complete this implementation within the current run" ($0.014, no
   tools called). The second:

   | cell | hidden | cost | wall | review | parent | graphs |
   | --- | --- | --- | --- | --- | --- | --- |
   | `graph-luna` (2026-09-28) | 875/891 | $3.08 | 34 min, cap | $2.51 | $0.39 | 5 |
   | `graph-luna` v2 | 848/891 | $1.63 | 30 min, timeout | $1.28 | $0.18 | 2 |

   - **Resumed review rounds are cheaper, measured per round** from the new
     `rounds` trace. Implementation reviews went $0.278, then $0.191, then
     $0.145, with cache writes of 23.7k, 13.1k and 11.1k tokens. The tests
     reviews went $0.193 then $0.107. The `tests-repair` reviews went $0.240
     then $0.049. A resumed round cost 31-80% less than the first.
   - **The parent followed the new guidance.** It gave the implementation
     `maxRounds 3` and planned two graphs instead of five. The first held
     implementation and tests in parallel, then integration.
   - **The parent turned review findings into a check by itself.** After
     `implementation` failed with 4 blockers, `impl-repair` carried them as
     executable assertions with no review, and passed first time for $0.012
     in 95 s.
   - **The time limit bound, not the cap**, during `final-integration`'s
     review. An aborted node's in-flight spend is counted, verified live:
     parent $0.184 + graph 1 $1.046 + graph 2 $0.403 = $1.633, the session
     total.
   - **The quality gap is one bug.** About 20 of the 43 failures are a
     projection after a flatten (`a[].b[].c`), solo-sol's bug, which
     yesterday's graph fixed. Whether a reviewer found it this time is not
     recorded: only a node's final report survives, and the implementation's
     first review raised 18 blockers. Another ~6 are a multi-select on a
     missing key.
   - The two graph cells are not equal-quality points. v2 was stopped with a
     review in flight, and one cell each has no variance.

   **Measured 2026-09-29: which acceptance a task needs decides whether the
   graph pays.** Three cells tested the hypothesis, on the latest build.

   | task | acceptance | arm | quality | cost | wall | sol share |
   | --- | --- | --- | --- | --- | --- | --- |
   | polyglot js29 | visible tests | solo-sol | 29/29 | $0.83 | 4 min | 100% |
   | | | graph-luna (checks) | 29/29 | $0.21 | 4 min | 48% |
   | polyglot py34 | visible tests | solo-sol | 34/34 | $0.87 | 3 min | 100% |
   | | | graph-luna (checks) | 34/34 | $0.30 | 8 min | 54% |
   | coldstart mustache | spec only | solo-sol | 135/135 | $0.24 | 4 min | 100% |
   | | | graph-luna (check + review) | 135/135 | $0.32 | 8 min | 87% |
   | coldstart jmespath | spec only | solo-sol | 862/891 | $0.67 | 4 min | 100% |
   | | | graph-luna v1 / v2 | 875 / 848 | $3.08 / $1.63 | 34 / 30 min | 94% / 90% |

   - **Where the tests exist, the graph is 3-4x cheaper at equal quality.**
     On py34, eight parallel luna nodes were accepted on their checks alone
     for $0.14 in all. Sol spent $0.16, all of it the parent planning.
   - **Where acceptance takes judgement against a specification, solo sol is
     cheaper.** On `mustache`, one luna node wrote the library for $0.037.
     Its sol reviewer took $0.214 over two rounds, 4 findings then none. That
     is 68% of the cell, and together with the parent the graph cost more
     than solo sol's whole run.
   - The direction held on all four tasks, one cell per arm each.
   - **Open: whether the review bought anything on `mustache`.** No
     `solo-luna` cell exists there. If luna alone resolves it, `mustache`
     fails criterion 1 and says nothing about supervision.
   - The resumed reviewer saved less on `mustache` ($0.120, then $0.094):
     round 2 re-wrote about 8k tokens, the size of the repaired code it
     re-read.

   What is left, in order:

   1. Tests-first on cold start: run and abandoned 2026-09-29. It writes the
      solution into the tests, the tests node alone costs at least what
      `solo-sol` does, and it forces a design on the model. Both arms and the
      `test-author` profile were removed from `bench/arms.mjs`; the results
      above stand.
   2. The refine baseline (T6): a trial-only `solo-sol-refine` arm, sol with
      "refine" sent twice in the same session under one cap ($2) and one
      limit (15 minutes), on `jmespath`. Built: `followUps` on the arm in
      `bench/arms.mjs`, sent after each settle under one deadline in
      `bench/cell.mjs`; the queue's own arm list is unaffected. Run
      2026-09-29; results above.
   3. Done: a valid graph cell called `worker_graph` and put at least one
      node under a review or a check. Fan-out is recorded in `graphSizes`,
      not required (`bench/preconditions.mjs`, `bench/DESIGN.md`
      **Preconditions on a valid trial**). Both recorded graph cells above
      now meet it.
   4. Done: a cell stopped by its spend cap or time limit is graded, with the
      grade in `detail` and the stop kept as its class; the container's
      processes are killed first (`bench/cell.mjs`).
   5. Close what the four tasks leave open, all cheap:
      - `solo-luna` on `mustache`. If luna alone resolves it, the task says
        nothing about whether review is needed.
      - `jsonpath` on all three arms, as a third specification-only task.
      - A repeat of `solo-sol` and `graph-luna` on `jmespath`, for a first
        look at variance. 875 against 862 is 13 cases in 891.
   6. Screen the `restore` suite (`bench/DESIGN.md` **The restore suite**):
      `solo-luna`, `solo-sol` and `graph-luna` on `toolz-spread-12` and
      `toolz-cluster-12`. It tests whether the test-backed saving survives
      real code with shared modules, and where coupling hands the win back to
      solo sol. Built and self-tested; no cell has run.
   7. Decide which claim the pilot tests (`bench/DESIGN.md` **What the bench
      says so far**). On current evidence the saving exists only where a
      command can accept the work. A pilot drawn from test-backed tasks (the
      polyglot bundles at twenty, grown with the Go, Rust, Java and C++
      exercises) tests that narrower claim. The cold-start tasks measure where
      it fails.
   8. Settle open decision 4, freeze the preamble, then `init`.

   The precondition that stood before those cells still stands: a pilot in
   which every arm scores zero discriminates nothing.

   The attribution the spend split needed is now in the package rather than in
   a fifth arm. A node's cost fused the `sol` reviewer with the `luna` worker,
   which is unrecoverable from outside; the review cycle keeps the reviewer's
   rounds in their own accumulator and reports them as `usage.review`, and
   `spendSplit` reads it as `reviewShare`. The arms stay 2x2 and `init` draws
   four.

   Then the first three tasks across all four arms, an estimated $17 to $67,
   for the spend split. It caps the saving the whole experiment can report and
   is cheap because it is a ratio taken inside one run. Two of the four open
   decisions are still unsettled. Whether a third review round buys anything
   does not block the harness. Whether the `graph` arms get extra orchestrator
   guidance on fan-out now does: at one decomposing cell in two, it decides
   what a `graph` cell is before any of them are drawn.

   The pool is 23 instances, not the 28 the statistical design's tables are
   computed at, so every figure in that section is optimistic by five. The
   conclusions do not change; they get slightly worse.
2. Keep every automated path provider-free behind the existing fake subprocess
   and injected orchestrator boundaries.

## Known defects

### A kill inside a mutation strands the run's mutation lock

`/swarm release` closes the hard-kill case for the owner record (D22), but the
lock is the other thing a kill can leave behind, and it is deliberately not
forced. A process killed while holding the run mutation lock leaves the file in
place with no holder, and every path that needs the lock then waits it out and
fails `locked`: the release, `deleteRun`, and a fresh `acquireRunOwnership`.
Verified against the built package — all three report "has a mutation in
flight". The run and its capacity slot are held until `mutation.lock` is
removed from the run directory by hand.

`recoverRunMutationLock` is not a way out. It takes an ownership capability,
and after a hard kill nobody holds one and nobody can acquire one.

It is recorded rather than fixed because the exposure is small and the fix is
not. The lock is held across one file write, where an owner record is held
across a whole run, so the window is orders of magnitude narrower than the one
D22 closed. Forcing it would give up the lock's stated contract — waited out
rather than resolved by force, recovered only by a holder shown to have
finished — which the deferred run-store work below depends on, and would race:
the supposed holder's release removes the file by path, so it would take a lock
acquired after it.

The fix, when something needs it, is the same shape as D22: an operator act
that names what it is giving up, not a timeout. It should wait the lock out
first, so an ordinary in-flight mutation is never interrupted, and it has to
solve the race before it is worth having.

## Deferred run-store work

Before a resumable or externally addressable run API is added, retain the
fail-closed ownership contract so two orchestrators cannot advance one run, and
the rule that a mutation lock is recovered only by a holder that can be shown
to have finished.

Retained text artifacts are complete end to end and their policy is settled in
D19: publication is deliberate, and neither overflow becomes truncation.

One question is left open deliberately. The orchestrator learns that an
artifact exists, and how large it is, but has no way to read it: the review
names `artifactBytes` and not a path, and no tool returns the text. A library
caller uses `readNodeArtifact()`. Giving the orchestrator the artifact's path
would make its own `read` tool sufficient, but that widens what the parent may
reach outside the checkout, so it is a decision rather than an addition.

## Deferred worker instruction work

The worker concurrency contract is now sent in the worker prompt
(`src/pi-subprocess.ts`) and asserted by the adapter suite: stay inside the
assignment, prefer small exact edits, reconcile rather than restore a file to
the version first read, never run git restore/reset/checkout/stash/clean and
never commit, push, or branch, no repository-wide formatters or generators or
dependency updates without explicit ownership, re-read changed files before
reporting, and report an unclear semantic conflict as a blocker instead of
guessing. The orchestrator guidance in `src/orchestrator.ts` carries the
matching parent-side decomposition, overlap, serialization, and acceptance
rules.

What remains undecided is one report field. `NodeOutput` carries `summary`,
`changedFiles`, `interfaces`, `decisions`, `validation`, and `blockers`
(`src/output.ts`), so an observation about another worker's edits can only
reach the parent's terminal report as prose in `summary` or as a blocker.
Adding a field is a schema version change.

It is less pressing than it was. A worker that notices a concurrent change
already has a structured channel while it runs — a `conflict` coordination
event (`src/store.ts`), which the parent and other workers can read — and a
retained artifact for the long form of what it saw. Neither is the terminal
report, so the question stands; it is no longer a dead end.

## Budget

Built 2026-09-29, once the bench measured a need for it. In the
`graph-luna-tests-reviewed` cell, the parent's session total stood at $0.14
for five minutes while a single node spent $1.32, which reached the session
only when the graph returned. Neither the bench's cap nor an operator could see
that spend, let alone stop it; only the node's timeout bounded it.

`maxGraphCostUsd` in `worker-graph.json` is checked in the orchestrator on
every worker's live progress, and enforced through the runner's existing abort
path. The two open questions are settled:

- **Cost, not tokens.** One graph mixes models whose token prices differ
  twentyfold (sol and luna), so a token ceiling would mean something
  different for every graph. Cost is the provider's estimate, and is what the
  operator is actually limiting.
- **It aborts running nodes; it does not wait for the frontier.** A check
  between frontiers would not have stopped the one-frontier node above.

The spend a stop records can overshoot by the turn in flight. A worker whose
telemetry is unusable reports zero progress usage, so it is under-counted
rather than refused.

The bench passes each cell's `--cap` as the graph arms' `maxGraphCostUsd`
(`bench/arms.mjs` `workerGraphConfig`). The harness's own poll still covers
the parent session.

The build with reviewer sessions, round traces, and the budget is packed as
`handoff/builds/review-sessions-traces-budget-2026-09-29.tgz` (gitignored,
hash in `SHA256SUMS`). No cell has run on it yet.

## Deferred attempt and recovery work

Phase 7 is the largest slice still unbuilt: attempt history, interrupted-run
state, and explicit retry and recovery controls.

Its value is worth questioning before it is built, because the obvious reading
overstates it. The shared checkout is the real state, and the documented
recovery is already available without any of this: read the checkout with the
parent's read-only tools and invoke another narrow graph for whatever is left.
A run interrupted halfway leaves its successful work on disk, not in the store.
What is actually lost is the run's own diagnostic record — which attempt did
what, and why it stopped — and whether that is worth a persistence layer is a
different and much smaller question than "recovery".

Two things would change the answer. A worker session that could be resumed
rather than restarted would make an attempt worth persisting in its own right,
and that depends on the adapter rather than on this decision. And a consumer
that runs graphs unattended and cannot inspect a checkout between them would
need the store to say what happened; nothing does that yet.

## Constraints to preserve

- Keep the implementation and exported API as small as possible.
- Validate the complete graph and runtime bounds before starting work.
- Do not add provider or model defaults.
- Do not add automatic Git operations or worktrees.
- Do not store runtime state in the target checkout by default.
- Do not propagate undeclared or unbounded context between tasks.
- Do not add recursive worker delegation.
- Use fake executors for automated integration tests.

## Decisions still needed

Retention cleanup and worker-session resumption semantics remain deferred until
their runtime layers are implemented. Review is now partly settled: D20 gives a
node its own work-review-repair cycle, and decides that a repair is a fresh
attempt rather than a resumed child session. Whether execution also pauses at
review barriers between frontiers is independent and still open. Broader Pi
compatibility can be claimed only after testing versions beyond the current
0.85.1 development pin, and the peer range in `package.json` now declares only
that pin rather than claiming what the README withholds. CI runs the Node axis
of the question — 22 and 24, the lowest version `engines` admits and the one
development runs on (`.github/workflows/ci.yml`). The Pi axis is untested and
is the dear half: every Pi API this package binds to is one Pi may change, so
widening the peer range is a decision to take after a second version has
actually been run.
