# Conditional escalation: a design for review

Status 2026-10-01: **parked proposal; nothing built.** Written after D24 was
measured and reverted ([`DECISIONS.md`](DECISIONS.md) D24). Parked because no
task in the bench makes luna stall where sol succeeds, so its central claim
cannot be tested yet, and because the counts allow a cheaper explanation for
failing nodes (repairs too narrow, see the second bullet below) that is to be
tested first, inside the existing runtime ([`NEXT.md`](NEXT.md) item 6a).

## The premise, and what the cells say about it

Cheap workers do the work; the stronger model (the orchestrator's) is drawn on
only for problems the workers cannot solve. If the stronger model is involved
when the workers would have managed, it is only cost.

Measured so far (`bench/DESIGN.md` **What the bench says so far**, **Pi 0.99.1
and D24**, **Repeats, 2026-10-01**):

- **With a command that accepts the work, luna plus the runtime's check loop
  resolves the bench's tasks**: polyglot, chess, and parso (3/3 at $0.40-0.52
  against solo sol's $2.13). The sol parent's share was 15-20% of those cells
  and did nothing a fixed loop could not: one node, the test command the task
  prompt gave, and one "continue" re-plan.
- **Why node 1 fails is now read from five cells without redirects**
  (G/H, 2026-10-02, `bench/DESIGN.md` **What the repair-tail cells say**).
  It is arithmetic: the work round removes about 190 of 455 failures, a
  repair a median 27, so four runs leave 169–231. The rate decays within a
  node, and one repair in six makes the suite worse. A new node's first
  round is no better than a repair (median −25 against −27); the large
  drops come in the second node's own repairs, at cumulative round six to
  eight, which fits "more rounds" as well as "a new assignment". A wider
  failure tail (12 KiB) changed nothing in node 1. So on this task a
  failed node 1 is not evidence of a capability ceiling; it is a round
  limit sized for a smaller task, with the open question whether the rate
  recovers inside an extended node (D25) or only in a fresh one. The
  repair prompt is `repairPayload` (`src/pi-subprocess.ts`), still "Fix
  the findings and nothing else".
- **Drawing on sol where workers were converging cost more and helped
  nothing.** D24 woke the parent on every check; it intervened on nodes that
  were improving, with less information than the worker had, and parso got
  2.3x dearer and 1.5x slower.
- **Without a command that accepts the work, solo sol is cheaper.** Acceptance
  then needs sol to judge against the specification, and each reviewer round
  re-acquires the understanding solo sol pays for once: sol was 87-94% of
  those graph cells' spend.

So the stronger model must be drawn on **conditionally**, and the condition
must be evidence that the workers have stopped making progress. Running out of
a fixed budget while improving is not that evidence.

## Two signals, not one

The bench has tests, so one command both says when work is wrong and accepts
it when it is right. In real work those are separable, and escalation needs
only the first:

- **An acceptance oracle** says the work is done. It has to be complete: a
  check that covers part of the task accepts work that does only that part.
  Measured: tests-first on `jmespath` scored 790/891 because the tests it
  wrote became the ceiling, and reviewing those tests cost $1.32.
- **A progress signal** says whether the last round moved the work forward.
  It only has to be monotone with the work. An incomplete test suite, a type
  checker's error count, a build's error count, a linter, a reproduction
  script the worker or parent wrote: each can say "stuck" without being able
  to say "done".

Escalation is triggered by the progress signal. Acceptance stays with whatever
oracle the task has: a check, a reviewer, or the parent reading the checkout.

## Where the progress signal comes from, in real work

In order of cost and reliability.

1. **A command the repository already has**: tests, type check, build, lint.
   Free to run, judged by the runtime. Most code changes have at least a
   compiler or type checker; many have tests near the change. This is the
   regime the bench measures.
2. **A command the parent writes for the task**: a reproduction script or a
   focused test, frozen like any check. This is where the orchestrator's
   intelligence pays most directly: turning an unverifiable task into a
   checkable one. It is a progress signal and, at best, a partial oracle; the
   tests-first measurement above says not to let it be the only acceptance.
3. **A reviewer's findings** (D20): stall is a finding count that does not
   fall, or the same findings repeated. This works anywhere, but every round
   costs a review on the stronger model, which is the regime the bench found
   loses to solo sol.
4. **The worker's own signals**: reported blockers, the worker's own test runs
   failing, repeated failed tool calls, no change to the checkout, a round
   hitting its time or turn budget. Free, but they say "struggling", not
   "wrong", so they can trigger escalation and never accept work.

Where none of 1-3 exists and the parent cannot write one, there is nothing to
detect a stall with, and conditional escalation has no basis. The cheaper
course there is the measured one: run the stronger model from the start. So
the first conditional decision is the orchestrator's, at planning time: what
can accept this work, and therefore which regime the task runs in.

## The mechanism, for a node with a progress signal

- **The parent names the progress number** when it writes the check, as a
  pattern over the command's output, for example `progress: "(\\d+) failed"`.
  The runtime reads it after each check. No pattern, or no match, keeps
  today's fixed rounds, so a wrong pattern costs the feature, not the node.
- **Improving** (the number fell since the last check): keep repairing, up to
  a hard ceiling above today's four. This targets nodes that run short of
  rounds, which the counts confirm for one of six.
- **Stalled** (no fall for `patience` checks, e.g. two): escalate.
- **Escalation runs the node's next repairs on a stronger profile**, named in
  the operator's configuration (no default, per AGENTS.md; usually the
  orchestrator's own model), with the same repair prompt, failing output and
  check. The stronger model works where the information is, in the checkout
  with the full failure output, rather than advising through the parent, which
  cannot write (`src/extension.ts:46`) and in D24 could only pass a count on.
  The cycle already changes profile per round for reviews
  (`reviewPayload`, `src/pi-subprocess.ts:1424`); an escalated repair is
  `repairPayload` (`:1475`) with another profile.
- **Bounds**: escalated rounds per node, and `maxGraphCostUsd` as now. A node
  whose escalated rounds also stall fails as today, and the parent re-plans
  from its report.

The orchestrator keeps its structural role, and gains one: choosing the
regime, writing the checks and progress patterns, decomposing, and
re-planning after a failure. It stops paying to watch converging work.

## Open questions

- **Does escalation stay escalated?** Sol for the rest of the node is simplest
  and bounded by cost; one sol round and back to luna is cheaper if a stall
  is usually one hard spot. Unmeasured.
- **A fresh or resumed session for the escalated round.** Resuming the
  worker's session carries what it learned; a fresh one avoids carrying a
  wrong approach. Unmeasured.
- **Progress without a number.** A check whose output carries no count can
  still show no change (the same failing output twice). Whether that is
  enough to call a stall is unmeasured.
- **Where the parent should be woken.** Never mid-node by default; possibly
  when an escalated node also stalls, with the full failure output rather than
  a count. D24's measurement argues against anything more.

## How it would be measured

1. **Improving nodes continue** (the mechanism without escalation), on the
   no-D24 baseline of three cells a task. Prediction: parso stops needing a
   second node, so cheaper and faster. This tests the out-of-rounds reading.
   The no-parent arm, `loop-luna` (`bench/DESIGN.md` **Arms**; built
   2026-10-02, not run), belongs here too: the parent's own first node with
   no sol parent at all, run again while it fails with work done. If it matches
   `graph-luna` on parso, the parent's 15-20% buys nothing on such tasks
   and every draw on sol has to be conditional.
2. **Find tasks where luna stalls and sol succeeds**, from solo cells. Parso
   and chess are not such tasks; on them escalation can only add cost.
3. **Escalation** on those tasks, against solo sol and plain graph-luna. It
   works if it resolves where graph-luna does not, for less than solo sol.
4. **Real-world proxies**: a task with a type checker or build but no tests,
   and one with only a parent-written reproduction, to see whether progress
   signals of kinds 1 and 2 detect stalls as well as a full suite.
