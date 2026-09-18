# Bench design: does orchestration with cheap workers cost less at the same quality?

An earlier fixture suite lived here and was deleted rather than committed: it
could not answer the question below, and the section on why is the part of it
worth keeping. Only its Pi RPC client survives.

## The question

One expensive model can do the work itself. Or it can decompose the work,
delegate it to workers on a model roughly twenty times cheaper, review what
comes back, and send it round again until it is right.

**Does the second arrangement cost less than the first without being worse?**

Cost is the claim. Quality is the constraint. A result that shows a saving
without establishing that quality held is not an answer, and neither is the
reverse.

## Why the first suite could not answer it

Four fixtures, graded by exact-output oracles over toy files: convert string
concatenation to template literals, change a function signature, fix an
off-by-one, find a shared-mutable-default bug.

Three things were wrong with it, in ascending order of seriousness.

The tasks were too small. `trivial` cost $0.0085 solo. Orchestration overhead
alone was measured at roughly 9,600 parent tokens for a single-task graph, so no
delegation can win there at any worker price. Every cell was a foregone
conclusion.

The graders were exact-output oracles. They reward mechanical string edits —
precisely what a cheap worker is already good at — and they are blind to
judgment, which is the thing the expensive orchestrator is supposed to be
buying. A suite like that reports "quality equal" almost by construction.

And the fan-out never happened. `wide` existed to test eight independent files
in parallel; the orchestrator put all eight into a single worker, on
`claude-haiku-4.5` and again on `gpt-5.6-sol`. The measured 3.9x cost was not
the price of parallelism. It was the price of one extra subprocess hop with no
parallelism at all. The treatment was never administered.

## Arms

Four, not two. All four run the same harness, the same checkout, the same task
text, and are graded identically. They vary two things independently — whether
the orchestration machinery is in the loop, and what model does the work.

| Arm | Machinery | Parent | Workers | Review |
| --- | --- | --- | --- | --- |
| `solo-sol` | no | `gpt-5.6-sol` | — | — |
| `graph-sol` | yes | `gpt-5.6-sol` | `gpt-5.6-sol` | yes |
| `graph-luna` | yes | `gpt-5.6-sol` | `gpt-5.6-luna` | yes |
| `solo-luna` | no | `gpt-5.6-luna` | — | — |

Two arms are easy to leave out, and each one leaves a different question
unanswerable.

**`solo-luna` is the floor.** Without it, "`graph-luna` cost less than
`solo-sol` at similar quality" cannot be told apart from "`luna` alone would
have done it and the whole apparatus is overhead".

**`graph-sol` separates the machinery from the model.** This is the one an
earlier draft of this design missed, and it is the more serious omission.
`graph-luna` differs from `solo-sol` in two ways at once: work moves into
subprocess workers under a report contract with bounded context on the
dependency edges and a review cycle, *and* that work moves onto a cheaper
model. If `graph-luna` comes out worse, nothing in a three-arm design says
which change caused it. A defect in `pi-worker-graph` — context that does not
reach a worker, a report contract that loses something the parent needed, a
review cycle that burns its rounds — would present exactly as "cheap workers
are worse", and the wrong conclusion would be drawn about models when the fault
was in the package.

`graph-sol` holds the model fixed and varies only the machinery. The three
comparisons it unlocks:

| Comparison | Answers |
| --- | --- |
| `solo-sol` vs `graph-sol` | what the machinery itself costs, in quality and in spend |
| `graph-sol` vs `graph-luna` | what the cheap workers cost, machinery held constant |
| `solo-sol` vs `graph-luna` | the product claim, both changes together |

The result worth having is **`graph-luna` near `solo-sol` on quality and near
`solo-luna` on cost**. The result worth having *first* is that `graph-sol` is
not worse than `solo-sol`, because if the machinery is lossy the economics
question is moot until the package is fixed.

### Ordering: the package question before the economics question

`solo-sol` against `graph-sol` is a question about this package, not about
model pricing, and it is the one whose answer changes what gets built next. A
machinery that loses ten points of resolve rate is a bug report; no amount of
worker-price arbitrage compensates for it, and measuring the arbitrage first
would be measuring on top of a fault.

Scope the claim to match what a small run can carry. At twelve tasks this is a
**screen for gross machinery loss**, not a measurement of it: a 40-point gap is
caught about two thirds of the time, a 20-point gap about a quarter. That is
the right scope for the stated worry — an inherent bug in the orchestration
path — and it is not a licence to report "the machinery is free".

Pricing, from Pi's catalogue, per million tokens:

| Model | Input | Output |
| --- | --- | --- |
| `gpt-5.6-sol` | $4.00 | $20.00 |
| `gpt-5.6-luna` | $0.20 | $1.20 |

Twenty times on input, seventeen on output.

### What the saving actually is

**That gap is between token prices. It is not the gap between arms**, and
conflating the two is the easiest mistake this document can invite. A `graph`
arm still runs an expensive parent that reads the repository to decompose the
work, and — under open decision 1 — an expensive reviewer that reads the diffs.
Only the middle is cheap.

Taking the per-run estimates from **Budget case**:

| | low | high |
| --- | --- | --- |
| `solo-sol`, `sol` throughout | $1.50 | $6.00 |
| `graph-*` parent, `sol` | $0.75 | $3.00 |
| `graph-*` reviewer, `sol` | $0.45 | $1.80 |
| `graph-luna` workers, `luna` | $0.08 | $0.31 |
| `graph-sol` workers, `sol` | $1.50 | $6.00 |
| **`graph-luna` total** | **$1.28** | **$5.11** |
| **`graph-sol` total** | **$2.70** | **$10.80** |

**The expected saving is about 15%, not twenty times.** The saving is bounded by
how much of the work leaves the expensive model, and under `sol`-reviews-`luna`
most of it does not. A more favourable split — a parent at 30% of `solo-sol` and
a reviewer at 20% — still only reaches about 50%.

Three consequences, and they shape the whole experiment:

**The cost claim is the hard one, not the easy one.** A small ratio needs more
tasks to establish than a large one, and the ratio here is small. See
**Sizing the cost claim**.

**The spend split is the first thing to measure**, because it caps the saving
before any quality question is worth asking. See **Start with the spend split**.

**The reviewer's share is measured inside the arm, not by a fifth arm.** The
reviewer is a large share of the remaining expensive spend, so telling it from
the parent's share is most of the difference between a 15% saving and a 40%
one. The first live `graph-luna` cell could not: a node reports one attempt
however many rounds it ran, so a `sol` reviewer and a `luna` worker arrived
fused, and from outside the package that is four cost equations in eight
unknowns. The package now reports the reviewer's share of each node's own
figures (`usage.review`), the spend split reads it as `reviewShare` beside
`nodeShare`, and the difference between them is the workers'. A
with-review/without-review pair would have answered the same question by adding
a factor to a 2x2 design and buying a fifth arm's cells; this answers it inside
the arms already drawn, at no provider spend.

Splitting the `graph` arms into with-review and without-review remains an
extension, and now only for the question it is actually the right instrument
for: whether review is worth its cost at all, which is open decision 2. That is
a separate question from attribution and is not a prerequisite for the spend
split.

**Both `graph` arms run the same parent, which is what makes fan-out cheap to
measure.** The parent decides the decomposition and it is `sol` in both, so
whether the orchestrator fans out is identical across them and `graph-luna`
answers it at roughly half the price. `graph-sol` earns its cost for the
machinery screen, which is a different question; it should not be bought for
this one.

`graph-sol` is the dearest arm in the design — every token on `sol` plus the
orchestration overhead on top, roughly 1.8x `solo-sol`. It is not there to be
economical. It is the control that makes the other arms interpretable, and its
own cost against `solo-sol` is itself the measurement of what the machinery
adds.

### Sizing the cost claim

Typical 95% confidence interval on the cost ratio, paired across tasks, from
`bench/power.py`:

| true saving | 3 tasks | 6 tasks | 12 tasks | 23 tasks |
| --- | --- | --- | --- | --- |
| 1.15x | 0.50–2.58x | 0.75–1.79x | 0.87–1.52x | 0.94–1.40x |
| 1.5x | 0.65–3.36x | 0.97–2.33x | 1.13–1.99x | 1.22–1.83x |
| 2.3x | 1.00–5.16x | 1.49–3.57x | 1.73–3.05x | 1.87–2.81x |
| 5x | 2.18–11.21x | 3.25–7.76x | 3.76–6.62x | 4.07–6.10x |

The last column is the whole pool, every task run once. Read the first row
carefully. **If the true saving is 15%, exhausting the pool still cannot
establish that `graph-luna` is cheaper at all** — the interval spans 1.0. Only
from about a 1.5x saving does a twelve-task run separate the arms, and only
from about 2.3x does a three-task run say anything.

This inverts an assumption worth stating plainly, because an earlier draft of
this design made it: cost was taken to be the cheap, robust half of the
experiment and quality the expensive half. Under the settled arm configuration
both are expensive, and the cost half may be the one that cannot be rescued by
spending more, because the effect itself may be near zero.

## Task source

### Primary: SWE-Bench ProMax, TypeScript subset

170 instances drawn from real commits across seven languages, 28 of them
TypeScript. Chosen for four reasons.

**It is the only public suite found that deliberately excludes narrow tasks.**
Instances average 11.4 modified files and 261.6 lines changed; tasks with
insufficient complexity or limited cross-file scope were filtered out during
curation. That is the regime the first suite failed to reach, and the only one
where delegation has anything to amortize against.

**It grades mechanically.** Each instance carries `image_name`, `test_patch`
and a gold `patch`, so the primary gate needs no judge. It does *not* carry an
`eval_script`, whatever the dataset card says, and the fail-to-pass set has to
be derived per repo -- see **Measured**.

**The best evaluated model resolves 41.2%.** This matters more than it appears.
A suite everything passes cannot show a quality difference, and neither can one
nothing passes. Around 40% is where a pass-rate comparison has resolution.

**The gold patch enables reference-anchored judging**, which is substantially
more reliable than open-ended scoring. See below.

Instance fields, as actually served: `instance_id`, `repo`, `language`,
`problem_statement`, `hints_text`, `base_commit`, `environment_setup_commit`,
`patch`, `test_patch`, `image_name`, `working_dir`, `created_at`,
`issue_numbers`, `pull_number`. Fourteen fields, and no `eval_script`; the
dataset card lists one.

### Top-up pools

28 paired instances is a small sample. If the non-inferiority margin needs more
(see **Statistical design**), extend from either of:

- **Multi-SWE-bench** — 1,632 instances across Java, TypeScript, JavaScript, Go,
  Rust, C and C++, curated from 2,456 candidates by 68 annotators.
- **SWE-bench Multilingual** — 300 instances across nine languages including
  JavaScript and TypeScript, compatible with the original SWE-bench harness.

Both are more localized than ProMax. Filter on gold-patch file count (≥3) to
keep the multi-file stratum intact, and record which pool each instance came
from so the strata can be reported apart.

## Grading

Two tiers. The judge never decides whether the work succeeded.

### Tier 1 — mechanical, the gate

Every target in the instance's derived fail-to-pass set passes, and nothing
that passed before regresses. Binary. This is the resolve rate and the
denominator for cost per resolved instance.

The set is derived rather than read: the dataset ships no `eval_script` and no
fail-to-pass list, so `bench/validate-instances.py` climbs from each
`test_patch` path to the nearest Bazel test rule, runs every rule before and
after the gold patch, and keeps the ones that flip. An instance yielding none
is not gradeable and is dropped before the queue is enumerated, so grading at
trial time reads a recorded target set rather than deriving one. See
**Measured**.

The agent must never see the tests. `test_patch` ships separately from the
checkout and is applied only at grade time, so a run cannot be gamed by editing
the thing that scores it.

### Tier 2 — judged, only on Tier-1 passes

Tier 1 answers "did it work". It cannot answer the question that actually
threatens this hypothesis: **did the cheap doers ship worse code that still
passes?** Collateral damage, duplicated logic, dead code left behind,
edits far broader than the issue required, an abstraction quietly destroyed —
tests are blind to all of it, and all of it is the characteristic failure of a
cheap worker.

So Tier 2 runs only on instances where both compared arms passed Tier 1, and it
compares them against the reference.

**It does not run at small task counts at all.** Both arms passing is roughly
41% of 41%, so twelve tasks yield something like four comparable pairs — fewer
than the identical-pair controls need to establish the bias floor those pairs
would have to clear. Running it anyway produces a number with no denominator
behind it, which is worse than reporting nothing, because it looks like
evidence. Tier 2 is gated on a count of comparable pairs fixed in advance, and
until that count is reached the judged comparison is reported as not run.

## The judge

Construction is dictated by known failure modes of LLM judges, not by taste.

**Reference-anchored and pairwise.** The judge sees the gold patch and both
arms' diffs, and answers which is closer to the reference in approach and in
scope. Not a 1–10 score: absolute scores from an LLM drift and carry no
calibration between runs.

**Position bias is real, and its direction varies by model family.** Every
comparison runs twice with the two diffs swapped. A verdict counts only when
both orderings agree; disagreement is recorded as a tie. This is
position-consistency checking, and skipping it means reporting the judge's
ordering preference as a quality result.

**Self-preference bias is real and stronger in more capable models**, with
reported effects ranging from -38% to +90% depending on dataset. The judge
therefore cannot be `gpt-5.6-sol` or `gpt-5.6-luna`. Use a different family —
`claude-opus-4.8` — so no arm is graded by its own model. `sol` judging
`sol`-orchestrated diffs is the documented failure exactly.

**Blind the arms.** Normalize diff formatting and strip comment-style tells
before the judge sees them. Swarm output may carry systematic signatures —
repair rounds leave different phrasing than a single pass — and a judge that
learns to spot the treatment is measuring the treatment, not the code.

**Calibrate the judge’s own noise.** Include identical-pair controls: the same
diff presented as both options. Every non-tie verdict on those is pure bias.
Report that number beside the result; it is the floor below which no judged
difference means anything. Consistency is not correctness — a bias repeated
reliably is still wrong.

## Metrics

Primary:

- **Resolve rate** (Tier 1), per arm, paired by instance.
- **Cost per resolved instance** — everything the arm spent on the stratum
  divided by the instances it actually resolved. It charges failures and retries
  to the arm that incurred them, which cost-per-attempt does not.

Secondary:

- **Judged quality** (Tier 2), as win/loss/tie against the other arm, with the
  identical-pair bias floor reported alongside.
- **Wall clock**, prompt accepted to settled.
- **Blast radius** — files changed outside the gold patch's file set.
- **Spend split** — orchestrator tokens against worker tokens, for each `graph`
  arm, with the reviewer's share broken out of the node side. This is what says
  whether the saving came from cheap workers or was eaten by the parent reading
  their reports — and, because a reviewed node runs a `sol` reviewer beside a
  `luna` worker, which of those two ate it. Reported as `nodeShare` and
  `reviewShare` of the same session total; their difference is the workers'.

Cost capture is already solved and needs no new instrumentation: the
`worker_graph` tool reports worker usage back through Pi's tool-usage channel,
so one `get_session_stats` call on the parent covers orchestrator and workers
together. Verified: a run whose workers spent 22,253 tokens reported 31,854 on
the parent, the difference being orchestration overhead.

## Preconditions on a valid trial

A trial that did not administer the treatment must not be scored as evidence
against it. Before a `graph` trial counts:

- `worker_graph` was called at least once;
- at least one graph had more than one task — `graphSizes` is a **precondition**,
  not merely a reported metric, because the first suite's central failure was
  scoring one-task graphs as if they were fan-out;
- where the review cycle is under test, at least one node carried a review
  policy.

Trials failing a precondition are recorded and reported as degenerate, with
their count stated. They are not silently dropped, and not counted as losses
either — a model that declines to fan out is a finding about the prompt surface,
and belongs in its own line of the results rather than buried in a pass rate.

## Statistical design

The pool is **23**: two instances yield no fail-to-pass target and the
ant-design three are out by decision (see **Why the ant-design three are out**).
Tables here lead with n=23 and keep n=28 -- the size of the TypeScript subset --
as the column the earlier sizing was done at, so the two can be read against
each other. Prose figures are the pool's unless they name n=28.

Losing five instances costs less than it sounds and more than nothing: the gap
the run can detect moves from 0.94 to 0.90 at 40 points and from 0.49 to 0.43 at
20 points. None of the conclusions change; they get slightly worse.

**"Quality stayed the same" is an equivalence claim, not a difference claim**,
and equivalence needs more samples than difference. At the pool of 23 with a
~41% base rate, the interval on a single arm's resolve rate is roughly ±20
points. That cannot distinguish "identical" from "fifteen points worse". Reporting "no
difference detected" as "quality is equal" would be the central dishonesty
available in this experiment.

Two levers against it:

**Pre-register a non-inferiority margin** before any trial runs, so the
threshold is not chosen after seeing the numbers.

An absolute margin in points is the wrong shape for it. The FDA's guidance on
choosing one puts the choice in two steps: **M1**, the whole effect the control
is presumed to have, and **M2**, the largest part of M1 it would be acceptable
to give up. The `solo-luna` arm is already what supplies M1 here — it is the floor,
and the orchestrator's entire value is `solo-sol` minus `solo-luna`. If `solo-sol`
resolves 41% and `solo-luna` resolves 30%, M1 is 11 points, and the placeholder
10-point margin would let `graph-luna` surrender 91% of everything the expensive
orchestrator buys and still be called non-inferior. Five points surrenders 45%
of it. Neither number means what it looks like until it is read against M1.

So the margin is a **retention fraction of M1**: `graph-luna` is non-inferior if it
retains at least *f* of the `solo-sol`-over-`solo-luna` effect. Pre-register *f*.

M1 is unknown until the bench runs, which is the one place this departs from
the drug-trial procedure — there, M1 comes from historical trials of the active
control, and here there is no history. Two consequences, both of which have to
be accepted openly rather than resolved: the acceptance threshold in points is
only computable after the arms have run, and a bench where `solo-sol` and `solo-luna`
turn out to be close has no M1 worth retaining a fraction of, which is itself
the finding that the orchestrator bought nothing. Pre-register a fallback
absolute cap alongside *f* to cover the second case, so a vanishing M1 does not
turn into an arbitrarily easy pass.

**Power, and what it rules out.** `bench/power.py` simulates a bench where the
two arms are truly equal and reports how often it would correctly conclude
non-inferiority, at a one-sided 95% bound on the paired per-task difference.
Regenerate with `python3 bench/power.py`; the table below was computed
2026-09-17 and the leading column is the actual pool rather than the subset:

| margin | n=23 | n=23, R=3 | n=28 | n=28, R=3 | n=56, R=3 | n=112, R=3 |
| --- | --- | --- | --- | --- | --- | --- |
| 5 points | 0.10 | 0.16 | 0.11 | 0.17 | 0.25 | 0.40 |
| 10 points | 0.18 | 0.34 | 0.20 | 0.40 | 0.62 | 0.87 |
| 15 points | 0.27 | 0.59 | 0.35 | 0.66 | 0.90 | 0.99 |
| 20 points | 0.43 | 0.80 | 0.50 | 0.87 | 0.99 | 1.00 |

An earlier version of this table was left in place after the bound switched
from a normal quantile to a t quantile, which is the correction `_critical` in
`bench/power.py` documents. It overstated every cell -- 0.39 where the current
model says 0.20 for a 10-point margin at n=28 -- and the claims under it were
read off it. The corrected ones:

**At one repetition the non-inferiority test is not available at any usable
margin.** The smallest margin reaching 80% power is 33 points at the pool of
23, and 30.5 at n=28. A 33-point margin is not a claim of equivalence; it is a
statement that the arms are not catastrophically different. Three repetitions
bring it to 20.5 points at n=23, which is still far above the 10-point cap
pre-registered in **Open decisions**.

Five points would need roughly 450 instances at three repetitions, and about a
thousand at one.

This is the decisive constraint on the whole design, and it is worse than it
looks. M1 is plausibly 10 to 15 points. The margin the pool of 23 can afford is
20.5 points at three repetitions and 33 at one. **The margin is wider than the
effect it exists to protect** — twice it, at one repetition — so at this sample
size the non-inferiority claim is not available at any value that means
anything. A 33-point margin is one the arm cannot fail.

Two things follow.

**Everything short of a confirmatory trial is a pilot.** That covers the whole
batched run described under **Budget case** and the full 28 as well. A pilot's
job is to measure M1 and the discordance rate, which is what sizes the real
one. It reports the observed gap with an interval and states that
non-inferiority was not tested. Calling an underpowered pass a demonstration of
equal quality is the dishonesty this section exists to prevent, and it is
available at every sample size the budget allows.

**Score the graded outcome, not the binary.** Per-instance pass fraction over
the three repetitions costs nothing extra — the repetitions are already
budgeted — and moves the achievable margin from 33 points to 20.5 at the pool
of 23. That is the single largest gain available, and it is still not enough to
reach the pre-registered cap. Keep McNemar on the binary as a secondary, since
it is the comparable number.

**The cost claim is underpowered too, for the opposite reason.** An earlier
draft of this section held that it was not — that a 17-to-20x price gap is
large and low-variance and n=28 settles it comfortably. That is the conflation
**What the saving actually is** exists to refute: 17-to-20x is the gap between
token prices, and the gap between arms is bounded by how much of the work
leaves the expensive model, which under `sol`-reviews-`luna` is expected to be
about 15%. At a true 1.15x saving the pool of 23 gives a cost-ratio interval of
0.94–1.40x — it spans 1.0, so the run cannot establish that `graph-luna` is
cheaper at all. See **Sizing the cost claim**.

So both halves are underpowered, and they fail differently. Quality is a large
effect the design cannot bound tightly enough to call equivalence. Cost is an
effect so small it may not be separable from zero at any sample size this
budget reaches — and unlike quality, spending more may not rescue it, because
the effect itself may be near zero. Neither half sets the tone for the other;
both are reported as intervals, and the pilot's job is to size a confirmatory
run for whichever one still looks worth buying.

**Pair by instance and analyze discordant pairs.** Between-instance difficulty
variance dominates everything else here. Comparing two independent rates throws
that away; McNemar over per-instance paired outcomes removes it and buys back
substantial power at the same n. Run every arm on every instance.

If the margin still cannot be resolved once the pool is exhausted, extend from
the top-up pools rather than narrowing the claim after the fact.

Repetitions: Pi exposes no seed, and run-to-run variance was large on the first
suite. Budget at least three repetitions per instance per arm, and treat a
single repetition as a smoke test rather than a measurement.

## Budget case: a resumable queue

The full pilot — the pool of 23, four arms, three repetitions — is 276 agent
runs at an estimated $384 to $1,533. That is more than this question is worth
spending in one go, and the estimate itself rests on per-instance figures
nobody has measured yet.

Per task at one repetition, all four arms: $5.56 low, $22.22 high. `graph-sol`
is roughly half of it on its own, which is the price of being able to attribute
a result to the machinery rather than to the models.

So there is no batch size. The bench is a **queue with a store**: every unit of
work is enumerated up front in a fixed order, the store records which ones have
been done, and a run executes as many of the next pending ones as you ask for.
Run three, read the costs, run nine more, run twelve. Stop for a week. The
store is the state, so "what is next" is always derived from what is already
recorded rather than tracked beside it.

The numbers below are therefore reference points for what a given amount of
accumulated work can support, not a schedule to commit to.

### Start with the spend split

The first cells off the queue should be **three tasks, all four arms**: twelve
runs, an estimated $17 to $67.

Not because three tasks measures anything about quality or cost — it does not,
and the tables below say so. Because the **spend split** is a ratio taken
*inside* one `graph-luna` run, between tokens spent on `sol` and tokens spent on
`luna`, and a within-run ratio needs almost no sample to pin down. Three tasks
settle it.

It is worth doing first because it caps everything downstream. If 85% of
`graph-luna`'s spend is parent and reviewer, the maximum achievable saving is 15%,
**Sizing the cost claim** says two dozen tasks cannot establish a saving that
small, and the honest move is to change the arm configuration rather than to
keep buying tasks. If the split comes out at 50/50, the saving is worth
measuring and the rest of the queue is worth working.

Three tasks also exercise every precondition — did `worker_graph` get called,
did a graph have more than one task, did review fire — which is the other thing
that can invalidate the run outright and costs nothing extra to check. On two
arms rather than one, so a precondition that fails only under cheap workers is
distinguishable from one that fails under the machinery generally.

### The unit of work

A **cell** is one task, one arm, one repetition — one agent run. The queue is
cells, so any count can be asked for.

Cells are ordered so that a task's arms are adjacent: task 1 on all three arms,
then task 2 on all three, and so on. Two consequences make arbitrary stopping
safe.

Analysis counts a task only when **every arm has completed it** at the same
repetition. Pairing is the whole basis of the statistics here — between-task
difficulty swamps everything else, and an unpaired task contributes noise
rather than information. Stopping mid-task is allowed and costs nothing; that
task simply is not counted yet.

So a status report names both: complete tasks, which is the n every figure
rests on, and pending cells, which is what remains to be paid for. Asking for
three cells and getting one complete task is the expected shape, not a
surprise.

### Why all three arms, however small the run

`solo-luna` is the cheap model with no orchestration, so it costs under 2% of
what a task costs across all four arms. Dropping it to save that is the worst
trade in the design: without the floor, "`graph-luna` cost less than
`solo-sol`" cannot be distinguished from "the cheap model alone would have done
it and the orchestrator was pure overhead".

`graph-sol` is the opposite case and the harder call, because it is about half
the budget. Dropping it buys twice the tasks and makes every quality result
unattributable: a deficit could be the cheap workers or a defect in the
package, and the two call for opposite responses. If the budget will not carry
four arms across the task count you want, run `graph-sol` on a **prefix** of
the tasks — six of twelve — and report the machinery screen at that smaller n.
That is a weaker screen, not a missing one.

Otherwise arms are never dropped to fit a budget; tasks are, and the queue does
that on its own by stopping earlier.

### Why tasks before repetitions

Twelve tasks at two repetitions and twenty-three at one cost about the same and
have about the same power — 0.41 against 0.43 for detecting a 20-point gap —
but twenty-three tasks covers nearly twice as much ground. The queue therefore
enumerates every task at repetition 1 before any task at repetition 2.

The exception is deliberate: repetitions are the only way to measure
run-to-run variance, and that variance is what sizes a later funded run. Once
the task count is somewhere useful, enqueue a second repetition across the
tasks already done rather than spreading repetitions thinly from the start.

### What a given amount of accumulated work can say

The columns are what this queue can actually produce: 23 tasks is the pool
exhausted, and nothing beyond it is buyable without the top-up pools.

| | 12x4x1 | 23x4x1 | 23x4x3 |
| --- | --- | --- | --- |
| Runs | 48 | 92 | 276 |
| Estimated cost | $67–267 | $128–511 | $384–1,533 |
| Cost ratio, if the true saving is 1.5x | 1.13–1.99x | 1.22–1.83x | 1.22–1.83x |
| Cost ratio, if the true saving is 1.15x | inconclusive | inconclusive | inconclusive |
| Preconditions fired | yes | yes | yes |
| Detects a 40-point quality gap | 0.63 | 0.90 | 1.00 |
| Detects a 20-point gap | 0.26 | 0.43 | 0.77 |
| If arms are equal, concludes "no worse than" | 31.3 pts | 21.6 pts | 13.5 pts |

Reproduce with `python3 bench/power.py`. Repetitions do not move the cost row:
the cost ratio is paired across tasks, and pairing is what the between-task
variance already costs. They buy quality power and run-to-run variance only.

Twelve tasks proves the mechanism fires, screens for gross machinery loss and
for catastrophe, and — if the saving turns out to be large enough to see —
bounds the cost ratio. It does not
establish non-inferiority at any margin worth the name, and a write-up that
implies otherwise is the failure the **Statistical design** section exists to
prevent.

### Accumulation

Stateful execution only works if the increments compose. Five requirements,
none optional:

**Fix the order before the first cell runs.** Draw a random permutation of the
task pool, record it in the store, and take cells off the front. An order
settled after seeing results is an order chosen for its answer.

**One append-only record per cell**, keyed by task, arm and repetition, holding
the Tier-1 outcome, the full usage and cost breakdown, the diff, the
preconditions, and the harness and package versions. Analysis reads the whole
store; it never reads "the last run".

**A cell is done or it is not.** A crash, a timeout, or a killed container
leaves no half-record: write the record once the run has settled and been
graded, so resuming re-runs the cell rather than inheriting a partial one. This
is what lets execution stop anywhere, including involuntarily.

**A harness failure is not a task failure.** A container that will not start, a
provider 500, a pull that times out, a cell stopped by its own spend cap — none
of those is the agent failing the task, and scoring them as losses would charge
an arm for the weather. Cells terminate into one of three classes: **resolved**,
**not resolved**, and **not attempted**. Only the first two enter the resolve
rate; the third is reported with its count and its reason and is eligible for
re-running, which the other two are not. The distinction has to be drawn by the
harness at the point of failure, because it cannot be recovered afterwards from
a record that says only "failed".

**Cap the spend of every cell.** The runtime bounds tasks, concurrency,
payload, output, context and per-task runtime, but has no token or cost ceiling
— `docs/NEXT.md` defers that deliberately — so one task that will not converge
can consume a whole budget unnoticed. The harness sets its own per-cell ceiling
from the measured median once there is one, stops the cell when it is crossed,
and records it as **not attempted** with the reason. A budget spent by one
runaway cell buys nothing at all.

**Re-run nothing silently.** A task re-run under a changed harness or package
version is a different measurement. Version-stamp every record, and either
report a mixed store as mixed or discard and redo the earlier cells.

**Keep the continuation decision blind to the outcome under test.** This is the
one that bites, and the stop-and-look workflow is exactly what makes it live.
Deciding whether to run more after seeing results is repeated testing of
accumulating data; stopping as soon as the numbers look favourable inflates the
false-positive rate well past the nominal 5%, and more looks makes it worse.

The rule that follows is narrower than "do not look", which would defeat the
purpose of a resumable queue. **Cost and preconditions may drive the decision
to continue; the quality gap may not.** Neither of those is the outcome under
test, so reading them between runs costs nothing. Stopping because the money
ran out is unrelated to the result and therefore harmless. Stopping because
`graph-luna` is currently ahead is not.

Two mechanisms hold it up:

- a status report shows spend, projected spend to finish, complete tasks, and
  whether the preconditions fired — and does not show the quality gap;
- the non-inferiority verdict is computed once, at a task count fixed in
  advance from the measured variance, by a separate step that has to be asked
  for.

The separation is imperfect and the leak is worth naming rather than leaving
implicit. Spend and quality are correlated: an arm that gives up early is both
cheaper and worse, an arm that flails is both dearer and worse. So watching
spend does carry some information about the outcome under test. Two things keep
it small. Status reports raw spend rather than cost per resolved instance,
which is the composite metric and would leak far more. And the leak runs
through a weak, unsigned correlation, where the thing being guarded against —
stopping the moment a verdict looks favourable — requires reading the verdict
directly. It is a narrowed channel, not a closed one, and a result should not
be defended as though it were closed.

The queue accumulates evidence. It does not hand out a verdict per run.

## What carries over, and what has to be built

The first suite's harness was deleted with its fixtures rather than committed:
its trial setup was `git init` over a toy folder and its grading was exact-output
oracles, and both are replaced wholesale below. One file survives.

**`bench/rpc-client.mjs`** is kept. It is a protocol-correct client for
`pi --mode rpc` and is independent of anything the first suite got wrong: strict
JSONL framing split on `\n` alone (`node:readline` is not protocol-compliant
here — it also splits on U+2028 and U+2029, both legal inside a JSON string),
request/response correlation, automatic answering of extension dialog methods so
a trial cannot hang waiting on one, and settle-waiting on `agent_settled`. The
new harness needs all of it, and it is also what drove the live verification of
the `/swarm` command surface.

Principles that carry over, to be rebuilt around containers rather than copied:

- the trial → grade → record loop, one JSONL record per trial;
- cost capture through a single `get_session_stats` call on the parent;
- blast-radius and `graphSizes` capture;
- holding the grader outside the checkout until grade time;
- per-trial isolation: throwaway agent directory, credentials copied from the
  real one, a fresh session each time.

Built, and covered by `npm run test:bench` against fakes:

- **Container setup** (`bench/container.mjs`). A per-instance Docker
  environment, capped in memory and CPUs because Bazel will otherwise take the
  whole host. The agent runs *inside* the container rather than on the host:
  the checkout only exists in the image, and `pi-worker-graph` spawns its
  workers in the target checkout, so a worker that cannot reach the checkout is
  not the package under test. Pi and the package are installed once into a host
  directory and copied in (`bench/toolchain.mjs`), which keeps a registry fetch
  out of the measurement and a 14 GB image layer off the disk budget.
- **Grading** (`bench/grade.mjs`). `test_patch` is applied only after the agent
  has finished. The target set is read from `validate-results.json` rather than
  derived per trial, and every target's outcome comes from Bazel's exit code
  rather than from its wording -- exit 4, no test ran, is a failure, and a text
  scraper reads it as success.
- **The queue, the store, and the commands over them** (`bench/queue.mjs`,
  `bench/store.mjs`, `bench/bench.mjs`): `init` draws and records the
  permutation once and refuses to redraw it, `run <count>` executes the next
  pending cells under a per-cell spend cap, `status` reports spend and
  preconditions and provably not the quality gap, and `analyse` has to be asked
  for.
- **Preconditions** (`bench/preconditions.mjs`), evaluated from the tool's own
  arguments. Arguments the stream did not carry are unknown, never satisfied.
- **Paired analysis and spend split** (`bench/analyse.mjs`): exact McNemar over
  discordant pairs, cost per resolved instance, and the worker share of a
  `graph` cell's spend, reported as unreadable rather than as zero when the
  tool's accounting cannot be parsed.

Still to build:

- **The Tier-2 judge**, including order swapping, blinding, and identical-pair
  controls. It is only worth building once the spend split says a saving is
  there to defend.
- **The live proof of the grading path.** `bench/grade-selftest.mjs` runs a
  cell with the gold patch standing in for the agent and expects every
  gradeable instance to grade as resolved. It costs no provider spend, and a
  gold patch that does not grade as resolved is a harness fault rather than a
  model one.

## What a cell exposes

A cell copies real provider credentials into a container built by someone else
and runs an agent in it as root. That is the security shape of this design, and
it is worth stating rather than discovering.

`auth.json` has to be inside the container, because Pi authenticates from the
agent directory and Pi runs where the checkout is. The image is a public Docker
Hub artifact carrying 1.8 GB of `node_modules` and a warm Bazel cache nobody
here built, and grading executes a large quantity of that code. An agent driven
by a model runs arbitrary `bash` in the same filesystem.

Five things bound it, and none of them makes the credentials safe:

- **The container can reach one host.** It runs on an `--internal` Docker
  network, which has no route off the machine, and a broker container attached
  to both that network and an ordinary one carries the provider's hostname as a
  network alias. The confined container resolves the provider to the broker,
  and the broker pipes bytes to the address it pinned before that alias
  existed. Everything else fails at DNS. Measured from inside a cell's own
  container: the provider answers 200 with the certificate validating, and
  `example.com`, `api.github.com` and the npm registry all fail to resolve.
  The relay never terminates TLS, so the handshake is end to end against the
  real hostname -- nothing in the path can read the traffic, which is also why
  nothing in the path has to be trusted with it. `BENCH_EGRESS=open` turns it
  off deliberately; a provider whose endpoint cannot be read from the
  catalogue is refused rather than guessed at, because confining a cell away
  from the provider it needs looks exactly like a model declining the task.

- **The credentials leave as soon as Pi is done.** The agent directory is
  removed from the container the moment the session closes, before `test_patch`
  is applied and before Bazel runs. That is a window, not a blast radius.
- **The container gives up what it never needed**: `no-new-privileges`, all
  capabilities dropped, a pid ceiling. Both halves were verified under the
  flags rather than assumed, and it took both. Grading a gold patch proved
  Bazel does not need the capabilities; that says nothing about the agent,
  because grading never reads the agent directory. Dropping `CAP_DAC_OVERRIDE`
  is what stops root ignoring file permissions, `docker cp` preserves the host
  UID, and the carried credentials were written `0600` -- so the container's
  own root could not read its `auth.json` or its model catalogue. Pi reported
  that as `Model not found`, not as a permission error. The files are now
  `0666`, `0777` where they were already executable, and the directory is the
  restriction, `0700` on both sides, so no capability had to be given back.
  Write and not only read, because Pi rewrites `auth.json` on a token refresh
  and `models-store.json` on a catalogue refresh, and `CAP_CHOWN` is dropped
  with the rest, so nothing in the container can take ownership instead. The
  toolchain tree is widened the same way and for the same reason: it is
  installed under the host umask and copied in whole, so under `umask 077` Pi's
  own binary arrives unreadable. The general lesson is the one this bench
  keeps relearning: a harness fault reaches the record wearing the costume of
  a model that could not do the task.
- **Nothing of the host is reachable**: no bind mounts, no Docker socket, not
  privileged, not host networking, memory and CPUs capped.
- **No interception is possible in the image as shipped**: no custom CA in the
  trust bundle, `NODE_EXTRA_CA_CERTS` unset, the npm registry is the public
  one. So the inherited proxy, had it resolved, would have seen CONNECT
  hostnames and not payloads.

**Confinement assumes the provider needs one host. Measured, for the arm that
runs here: it does.** A `solo-luna` cell on `azure-openai-responses` under key
auth completed 21 turns and 20 tool calls with its container able to reach
nothing else, and the broker logged three connections and no failures. It would
not hold for a provider that exchanges a token somewhere else first -- `github-copilot` at `api.github.com`, or Azure under AAD at
`login.microsoftonline.com` -- and the symptom would be a cell that settles
having spent nothing, which is the failure this design is least able to
tolerate. Two things make it visible rather than silent: such a cell is classed
`not-attempted`, never scored, and every record whose cause the relay could
settle -- spent nothing, did not settle, or failed as harness -- carries the
broker's log, alongside the host the cell was confined to or `open`. One
`relay up` with no `connect` line means the confinement was pointed at the
wrong host or an insufficient one. A `connect` line means traffic reached the
provider and the fault is elsewhere. That distinction earned its place on the
first live trial: a cell failed at `set_model` showing `relay up` and no
`connect`, which ruled out the network in one reading and sent the search to
the container's filesystem, where the fault actually was.

A second residual: the relay pins the addresses it resolved at the start of the
cell, and a cell may run for an hour against an endpoint with a short TTL.
Every address the host resolves is carried, and a connection that cannot reach
one tries the next, so a withdrawn address is survivable and a wholesale
renumbering mid-cell is not. Low probability, accepted rather than fixed.

The failover was measured rather than reasoned about, because the first
version of it did not work: two Docker containers standing in for the
endpoint, one dead and one live, a relay given both, and a client through it.
An index that advanced twice per retry re-dialled the address that had just
failed, which with the two addresses a real endpoint usually has meant no
failover at all. Worse, a retry could fire after the client had been piped to
a dead upstream -- its handshake already consumed, so the replacement
connection received nothing and the cell hung until its settle window expired
rather than failing one request. The guard is now "never connected" and the
index advances once.

Grading was checked against the confinement rather than assumed compatible
with it: a Bazel test target builds and runs to a pass on the internal network,
because the image's cache is warm enough to need no fetches.

Running the agent in a separate container from the checkout was considered and
rejected. The state an agent needs spans `/testbed` and `/root/.cache/bazel`,
about 5 GB, and the agent container would need the same toolchain anyway to
build and test -- which in practice means the same image, buying nothing. An
agent that cannot run tests is measuring a different task. And the split would
not remove untrusted code execution, only separate it from the credentials,
which the egress confinement does more cheaply and without touching what is
measured.

**The mitigation that actually matters is not in this repository.** Point
`BENCH_AGENT_DIR` at a directory holding a scoped, rotatable key that reaches
the two arm models and nothing else. Running the bench with credentials you
would mind losing is the risk; everything above only bounds it.

Note also that clearing the inherited proxy is what gave these containers
working egress at all. Before it they could reach nothing, which was
containment by accident rather than by design, and the bench cannot run that
way -- but it did mean the exposure described here arrived with that fix.

## Threats to validity

**A refactoring benchmark is the best case for fan-out.** ProMax selects for
coordinated multi-file change, which is the regime most favourable to
delegation, exactly as the first suite was the least. Quoting only this result
would repeat the earlier mistake in the opposite direction. Bracket it with the
more localized SWE-bench Multilingual tasks before drawing a general conclusion.

**ProMax rewrites issue descriptions to be precise and unambiguous.** Good for
reproducibility, less like a real ticket. An orchestrator's value may lie partly
in resolving ambiguity, and this suite removes that work from the task.

**Contamination.** These datasets are public and probably in training data.
Both arms share base models, so contamination largely cancels — it threatens
absolute resolve rates, not the A/B delta. Worth stating so the result is not
dismissed for the wrong reason.

**Profile names are now part of the treatment, not scaffolding.** The first
suite compensated for a real defect with a one-line `--append-system-prompt`
naming the profile, because nothing enumerated the configured names and every
guessed name rejected the whole graph. The package closes that gap (D21): while
worker-graph mode is enabled it prepends the configured profiles — name,
provider, model, thinking level, and a read-only marking — to the parent's
request. The new harness must therefore **not** carry the patch forward. Doing
so would name the profiles twice and measure the harness's prompt rather than
the package's.

Two consequences for the `graph` arms. Their parents carry a block the solo
arms do not, so a few hundred tokens of the arm's cost are the mechanism's own
and should not be mistaken for orchestration overhead. And the block marks a
profile read-only when no tool it holds can change the checkout, which is a
nudge toward a particular `review.profile` choice. Open decision 1 settles that
the reviewer runs `sol` on read-only tools, so the nudge and the arm agree; had
the reviewer been given a writable profile, the block would not have endorsed
it and the disagreement would have belonged in the disclosure.

**The pilot is an Angular benchmark.** Not mostly Angular -- entirely. 25 of
the 28 TypeScript instances are `angular/angular`, and the ant-design three are
out of the pool by decision, so all 23 gradeable instances come from one
repository. A result from this pilot is a statement about Angular, and the
write-up has to say exactly that rather than "TypeScript". Widening means the
top-up pools, not the three that were dropped; three instances would not have
made it a statement about anything broader.

**Judge-blind failure.** If the identical-pair controls show high bias, Tier 2
is uninformative and must be reported as such rather than quietly used anyway.

## Open decisions

1. ~~**Reviewer model.**~~ **Settled: `sol` reviews `luna`.** Faithful to
   thinker-plus-doer, and the alternative — `luna` reviewing `luna` — risks a
   rubber stamp, which would make the review arm meaningless rather than merely
   cheap. The cost is the known one: the thinker reads all the work anyway, so
   review spend may erase part of the saving. That is now a result to measure
   rather than a decision to make, and the **spend split** metric is what
   reports it — its `reviewShare` is the reviewer's own part of the node side,
   so "the saving was eaten by the reviewer" is now directly readable rather
   than inferred from a blended figure.

   The reviewer profile takes `sol` as its model and read-only tools: `read`,
   `grep`, `find`, `ls`. Model and tools are independent, so this keeps the
   package's read-only marking pointing at the reviewer the arm intends.
2. **Review rounds.** `maxRounds` of 2 is the cheap default. Whether 3 buys
   anything is measurable and unmeasured.
3. ~~**Non-inferiority margin.**~~ **Settled: f = 0.5, absolute cap 10
   points.** `graph-luna` must retain half the `solo-sol`-over-`solo-luna` effect, and in
   no case fall more than 10 points behind `solo-sol`. Neither is testable at
   the pool of 23 — see **Statistical design** — which is why the first run is a
   pilot that measures M1 and discordance and sizes the confirmatory run from
   them. The numbers are pre-registered here so that sizing cannot quietly
   become a choice of margin.
4. **Whether the `graph` arms get extra orchestrator guidance on fan-out.** The
   first suite showed models collapsing independent work into one worker. The
   package ships its own fan-out guidance in the tool's prompt guidelines; any
   strengthening on top of that is arm configuration and must be disclosed,
   and it is the last remaining place where the harness could put words in the
   orchestrator's mouth.

## Measured

Spike run 2026-09-15 on `angular__angular-64903`, one instance, no agent and no
provider spend. It replaces the three facts that were unverified here, and
turned up three more.

- **There is no `eval_script`, and no fail-to-pass / pass-to-pass lists.** The
  dataset has 14 fields and carries none of them, and no grading script is baked
  into the image either. Tier-1 grading has to be derived per repo: map the
  `test_patch` paths to a build target, run it, read the result. The design
  assumed this field existed; it does not.
- **Containers pull cleanly and need no setup.** 2.56 GB for angular
  (1.78–1.85 GB for ant-design), 234s to pull, with `node_modules` (1.8 GB) and
  a warm Bazel cache already baked in, on Node 22 and pnpm 10. No install step.
- **Runtime is not the bottleneck.** 23s for the pre-patch run and 3s for the
  post-patch one. The one-time image pull dominates a cell, not the test.
- **The TypeScript subset is effectively one repository:** 25 of 28 instances
  are `angular/angular` and 3 are `ant-design/ant-design`. The pilot is an
  Angular benchmark with a rounding error attached. See **Threats to validity**.
- **The pre-state fails to compile rather than failing a test.** The gold
  patch's API does not exist yet, so `test_patch` is a TypeScript error, and
  Bazel reports `Executed 0 out of 1 test: 1 fails to build`. A grader keying on
  test counts alone cannot tell that from a cache hit; key on the exit code and
  the `Executed N out of M` line together.
- **Bazel caches test results.** A re-run without `--nocache_test_results`
  reports `(cached) PASSED` and `Executed 0 out of 1 test`. Grading must pass
  that flag or it will score a stale result as a fresh pass.

Then run on five instances to see whether the grading generalises. **Four of
five validate.** The derivation is: changed test file → climb to the nearest
`BUILD.bazel` that declares a test rule → run each rule. The oracle is per
target, not aggregated — run each before the gold patch and after, and keep the
ones that flip fail→pass. That set is exactly what the missing fail-to-pass
lists would have given us.

It has to be per target. On `c_1d3b914` the derivation yields six targets, three
of which pass before the patch as well as after; only the three `symbol_test`s
flip. An aggregated pass/fail would have scored the instance on tests the patch
never touched.

The fifth, `c_4a3d39c`, patches a schematics test helper. Nothing between it and
`packages/core` declares a test rule, so the climb overshoots and grabs five
unrelated targets that fail both before and after. It yields no fail-to-pass set
and is dropped. That is the design working: validation costs no provider spend,
so an instance the harness cannot grade is filtered before it costs anything.
The number that matters is the yield, and two of the five were picked because
their patches looked awkward, so 80% is a floor rather than an estimate.

Grading runtime once the image is local: 9s to 112s per instance.

The Angular subset is now swept in full: **25 of 25 validated, 23 with a
fail-to-pass set — 92% yield, 78 targets in total.** The two without are
`c_4a3d39c` and `c_7118dac`, both patching test helpers the climb cannot
resolve to a test rule. **The pilot is sized on 23**, which is a real loss of
power against the 28 the design was originally sized at rather than a rounding
error -- the tables in **Statistical design** now carry both, and the n=23
columns are the ones that apply.

### Why the ant-design three are out

**Settled: dropped. The pool is 23.** They are recorded in
`bench/excluded-instances.json`, which both the validation sweep and the pool
loader read, and deliberately not in `validate-results.json` -- nothing was run
on them, and that file's warrant is that every row in it was measured.

Cost is not the reason, and an earlier draft of this section had it as the
reason. A jest path -- run the changed test file, per file -- is *simpler* than
the Bazel climb already built. Four other things decide it.

**It buys no power.** At one repetition, from `power_gap` in
`bench/power.py` (the 26 row is the hypothetical, so it is not a column of the
table `python3 bench/power.py` prints):

| pool | detect a 40-point gap | a 30-point gap | a 20-point gap |
| --- | --- | --- | --- |
| 23 | 0.90 | 0.70 | 0.43 |
| 26 | 0.93 | 0.75 | 0.47 |

Three instances move the machinery screen by three points of power. That is
inside the noise of the placeholder resolve rate the simulation is centred on.

**It does not fix the threat it looks like it fixes.** 23 Angular plus 3
ant-design is still an Angular benchmark, and the write-up still has to say so.
See **Threats to validity**.

**The grader would be an exact-output oracle on the largest one.** In
`ant-design__ant-design-52470`, 13 of the 15 files the `test_patch` touches are
`__snapshots__/*.snap`, and the change in them is a class rename --
`ant-skeleton-content` to `ant-skeleton-section` -- which the problem statement
spells out by name. Grading it scores whether the agent reproduced a named
string. That is the grader **Why the first suite could not answer it** says
reports "quality equal" almost by construction. No Angular `test_patch` in the
subset contains a snapshot file at all.

**Two graders make a three-instance difference unattributable.** Every Angular
instance is graded by one derivation with one oracle. A second path means an
arm-level difference on those three could be the grader rather than the arm,
and in a 23-task paired design there is no n to spare on noise.

The honest counterweight, recorded because it is the one real loss:
`ant-design__ant-design-53739` is the instance in the subset best shaped for
fan-out -- a 39-file gold patch spanning drawer, dropdown and tooltip, with
only 1 of its 6 changed test files a snapshot. It is not worth a second grading
path on its own.

Removing an entry from `bench/excluded-instances.json` is how this is
revisited; the sweep picks the instance up again on its next run.

**The grading path is proven on 6 of 23 instances, including every complex
shape in the pool.** `bench/grade-selftest.mjs` runs a cell with the gold patch
standing in for the agent -- `test_patch` applied afterwards, Bazel's exit code
read -- and all six graded as resolved, at no provider spend:

| instance | targets | regression targets | grade |
| --- | --- | --- | --- |
| `angular__angular-64903` | 1 | 0 | resolved, 327s |
| `c_0362665` | 11 | 11 | resolved, 546s |
| `c_5e0dcf1` | 11 | 11 | resolved, 626s |
| `c_9f44b41` | 12 | 11 | resolved, 695s |
| `c_c089d21` | 11 | 11 | resolved, 582s |
| `c_e3dcf52` | 8 | 8 | resolved, 552s |

The five after the first were chosen rather than taken in order, because the
first proved only the pool's simplest shape -- one target, no regression set --
and `resolveTier1`'s regression branch had therefore never run. These five hold
every multi-target instance in the pool, 54 of its 78 targets and 52 of its
68 regression targets. The branch now runs clean five times.

The remaining 17 are single-target instances of the shape already proven, so
what is left is breadth rather than a new code path. 50m of wall clock for the
five. How much of that was pulling is not recorded -- the selftest writes only
a total per instance -- but validating the same five spent 57% of its time on
pulls, and the selftest does the same pull with half the test runs.

**The images carry their builder's proxy, and it silently disables every
provider.** The ProMax containers set `http_proxy` and `https_proxy` to
`sys-proxy-rd-relay.byted.org:8118` in the image environment. That host
resolves only inside the network the dataset was built on, so every outbound
request from inside one fails -- `curl` exits 5, `COULDNT_RESOLVE_PROXY`,
against Azure and Copilot alike. Measured on `angular__angular-64903`; cleared,
both connect.

What it looks like from outside is the dangerous part. Pi accepts `set_model`,
which only checks the local catalogue, accepts the prompt, retries three times
on `Connection error.`, and settles. The session looks clean, the checkout is
untouched, and the arm is recorded as having failed the task. The first live
cell of this bench did exactly that and was graded `not-resolved` at a cost of
$0.00. `startContainer` now passes each proxy variable empty to override the
image, and a cell that settles on zero tokens is classed `not-attempted`
rather than scored -- two independent guards, because either alone would have
let this through.

**The first live cell cost a twentieth of its estimate, because of caching.**
`solo-luna` on `angular__angular-64903`, confined, graded: 21 turns, 20 tool
calls, a 2,438-byte diff over two files, unresolved on a target that still
failed to build. 190s of wall clock and **$0.016** against the $0.08-$0.31 this
document estimates for that arm.

The reason is in the token split, and it is the whole finding:

| | tokens | price /M | cost |
| --- | --- | --- | --- |
| input | 63 | $0.20 | $0.00001 |
| output | 4,508 | $1.20 | $0.00541 |
| cache read | 261,823 | $0.02 | $0.00524 |
| cache write | 21,227 | $0.25 | $0.00531 |
| **total** | **287,621** | | **$0.01597** |

Ninety-one percent of the tokens were cache reads at a tenth of the input
price. Every estimate in **Budget case** is computed from input and output
prices alone and is therefore too high, perhaps by a large factor.

Three cautions before anything is resized on this. It is one instance, on the
cheapest arm, at one repetition. The `graph` arms pay orchestration overhead
that caching does not erase, and their parent re-reads a repository across
worker turns in a way a solo arm does not, so their cache behaviour may differ
in either direction. And a cache hit rate measured on a task the agent failed
in 21 turns is not obviously the rate on one it solves in sixty.

What this does settle is that the twelve-cell spend split is cheap enough to
buy without further deliberation, which is the decision it was blocking.

**The first `graph-luna` cell: $1.39, 20 minutes, and the fan-out did not
happen.** Four `worker_graph` calls, every one a single-task graph, on a real
ProMax instance with workers that genuinely ran -- `recon` 11 turns,
`implement-fieldtree-enumeration` 70, `repair-fieldtree-enumeration` 71,
`final-proxy-invariant-repair` 17, two of them reviewed. The checkout gained
14,211 bytes across four files and the target still failed to build.

`graphSizes: [1,1,1,1]` is now a finding rather than an artefact. The first
suite died of exactly this -- see **Why the first suite could not answer it** --
and the package has since shipped its own fan-out guidance in the tool's
prompt. On this instance it was not enough. That is the evidence open decision
4 was waiting for, and one instance is not enough to settle it: the task may
genuinely be one worker's worth of work.

**The first spend split: 73.65% of the cell went to node work, 26.35% to the
orchestrator.** It is one cell, and it is not the number the design asked for.
Read **Start with the spend split** with the limitation below.

**A node's cost was a blend of worker and reviewer. Fixed in the package.**
The tool reported one cost per node, and a node sums every round of its
work-review-repair cycle into one attempt (D20). The reviewer runs `sol` and
the worker `luna`, so the figure was a mixture: measured implied prices were
$1.12/M input and $8.10/M output, against `luna` at $0.20/$1.20 and `sol` at
$4.00/$20.00. Neither matches, and four cost equations cannot resolve eight
unknowns.

It is irreducible from the bench and trivial in the adapter, which runs the
rounds and therefore knows which of them was a review. The review cycle now
keeps a second accumulator and reports it as `usage.review`, a share of the
node's own figures; `spendSplit` reads it as `reviewShare` beside `nodeShare`.
The alternative on the table was a fifth, review-free arm, which would have
answered the same question by adding a factor to the 2x2 and buying another
arm's worth of cells. This measurement is what promoted the arm, and the
package change is what demoted it again.

**The metric had never run.** `spendSplit` called `JSON.parse` on the whole
result text and looked for `nodes` or `reviews`. The tool emits prose wrapping
a `<worker_graph_reports_json>` block holding a bare array, so every real cell
returned unreadable -- safely, and therefore silently. It was found by running
one cell and would otherwise have been found after twelve. The parser now reads
the real shape, and the first thing it parses in its test is the text captured
from that cell.

One caution recorded because it was nearly published as a finding: the reported
cost object carries `total` beside its components, so summing the object's
values double-counts exactly. A 73.65% share read as 147% that way, which
looked like the two sides disagreeing. A share above 1 is now surfaced as
`inconsistent` rather than averaged into a headline, and the token counts --
which reconciled exactly, 2,971,372 in nodes plus 245,073 in the parent
against a session total of 3,216,445 -- are what confirmed the accounting was
sound.

Budget disk as well as tokens — an image is 2.5 GB compressed and ~14 GB
unpacked, so a cell holds that much while it runs, and `BENCH_RMI=1` drops each
image after its instance. Results are written per instance, so a resumed run
only repeats what it has not done.

**A sweep can be killed for host memory, and the cause is not settled.** Four
runs died on a 13 GB box, always during the pull and never during the grading.
Two mitigations were tried. A prune of dangling layers after each image
reclaimed 0B every time -- `docker rmi` on a tagged image with no other
references already drops its layers -- and it was removed rather than kept,
because on a shared box a prune is also free to take another project's dangling
layers. A wait for `MemAvailable` to recover before each pull was kept, but it
never engaged on the six-instance sweep that first completed: memory never fell
below the threshold. So neither is shown to be why a sweep now finishes. The
likelier difference is that the runs that died shared the box with a test
suite. Treat the wait as cheap insurance whose value is unmeasured.

## Running it

```bash
# 1. Derive the fail-to-pass targets the dataset does not ship. Resumable, and
#    on a small host it has to be: an image is ~14 GB unpacked.
BENCH_RMI=1 python3 bench/validate-instances.py            # or name instances

# 2. Prove the grading path with no provider spend: the gold patch stands in
#    for the agent and must grade as resolved.
BENCH_RMI=1 node bench/grade-selftest.mjs

# 3. Draw the task order, once. Refused while instances are still unvalidated;
#    the excluded ones count as accounted for, so this needs no flag.
#    BENCH_PROVIDER is set here deliberately rather than inherited: the
#    manifest records it, and every later run is checked against it.
BENCH_PROVIDER=azure-openai-responses node bench/bench.mjs init --seed 1234

# 4. Prove the agent side on two chosen cells before buying twelve drawn ones.
#    Neither writes a record: a hand-picked cell is not a sample from the order.
#    The solo cell proves the harness -- pull, container, agent directory, Pi,
#    the session, the settle loop, the cap, the diff, the grade. It cannot
#    prove the package: a solo arm is given no worker-graph.json and no package
#    tree, so there is no `/swarm on` in it. That needs a graph arm, and
#    graph-luna is the cheapest one.
BENCH_RMI=1 node bench/bench.mjs cell angular__angular-64903 solo-luna --cap 2
BENCH_RMI=1 node bench/bench.mjs cell angular__angular-64903 graph-luna --cap 8

# 5. Work the queue, a few cells at a time.
BENCH_RMI=1 node bench/bench.mjs run 12 --cap 5
node bench/bench.mjs status
node bench/bench.mjs analyse
```

`status` is what may be consulted between runs; `analyse` is the quality gap
and has to be asked for. `cell` is outside the queue and outside the store: it
is how the first live cell gets chosen rather than drawn, and it refuses to
write anywhere the analysis reads.

**`--cap` is required on anything that can spend.** An absent cap means no
ceiling at all, and the package under test has no budget of its own -- that is
deferred deliberately, on the grounds that the operator watching a run is the
enforcement. So this flag is the only ceiling there is, and a ceiling that
disappears when you forget it is not one. A cell that genuinely needs no limit
says so by naming a large number.

**The provider is part of the measurement, not of the environment.** Both
`github-copilot` and `azure-openai-responses` are authenticated on the
development box and both catalogues carry `gpt-5.6-sol` and `gpt-5.6-luna`, so
the choice is live. The bench runs on `azure-openai-responses` because it bills
per token against a rate card the write-up can name, and this experiment's
primary claim is cost; Copilot bills on request quotas, so its token counts
would be priced from the catalogue rather than from what the account was
charged. `BENCH_PROVIDER` is therefore set explicitly at `init`, recorded in
the manifest, and enforced on every later run -- forgetting it on a second
sitting would otherwise fall back to the agent directory's default and pair
cells measured against two rate cards. A `cell` trial is held to the store's
provider too when a store exists, so a path proven on one rate card is not then
bought on another.

Environment: `BENCH_RMI=1` drops each image after its instance, `BENCH_MEM` and
`BENCH_CPUS` cap the container, `BENCH_PROVIDER` names the provider serving the
arm models, `BENCH_AGENT_DIR` is the real agent directory credentials are
copied from, and `BENCH_STORE` is the store.

## Sources

- SWE-Bench ProMax — <https://arxiv.org/abs/2608.09802>,
  dataset <https://huggingface.co/datasets/swe-bench-promax/SWE-Bench-ProMax>
- Multi-SWE-bench — <https://github.com/multi-swe-bench/multi-swe-bench>
- SWE-bench Multilingual — <https://www.emergentmind.com/topics/swe-bench-multilingual>
- Bias in the Loop: Auditing LLM-as-a-Judge for Software Engineering —
  <https://arxiv.org/html/2604.16790v1>
- A Systematic Study of Position Bias in LLM-as-a-Judge —
  <https://aclanthology.org/2025.ijcnlp-long.18.pdf>
- Beyond the Surface: Measuring Self-Preference in LLM Judgments —
  <https://arxiv.org/pdf/2506.02592>
- Non-Inferiority Clinical Trials to Establish Effectiveness (FDA guidance for
  industry, 2016) — <https://www.fda.gov/media/78504/download>; the M1/M2
  two-step for choosing a margin
- Reporting of Noninferiority and Equivalence Randomized Trials: Extension of
  the CONSORT 2010 Statement —
  <https://jamanetwork.com/journals/jama/fullarticle/1487502>
