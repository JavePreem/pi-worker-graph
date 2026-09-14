# Bench design: does a thinker with cheap doers cost less at the same quality?

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

Three, not two. All three run the same harness, the same checkout, the same
task text, and are graded identically.

| Arm | Parent | Workers | Review |
| --- | --- | --- | --- |
| `thinker` | `gpt-5.6-sol` | — | — |
| `swarm` | `gpt-5.6-sol` | `gpt-5.6-luna` | yes |
| `doer` | `gpt-5.6-luna` | — | — |

`doer` is the one that is easy to leave out and must not be. Without it,
"`swarm` cost less than `thinker` at similar quality" is uninterpretable: if
`luna` alone scores the same, the orchestrator bought nothing and the whole
apparatus is overhead. `doer` establishes the floor. The result worth having is
**`swarm` near `thinker` on quality and near `doer` on cost**.

Pricing, from Pi's catalogue, per million tokens:

| Model | Input | Output |
| --- | --- | --- |
| `gpt-5.6-sol` | $4.00 | $20.00 |
| `gpt-5.6-luna` | $0.20 | $1.20 |

Twenty times on input, seventeen on output. The gap is wide enough that if
delegation ever pays, it pays here and is easy to detect.

Splitting `swarm` into with-review and without-review separates delegation from
the review loop. That is the extension once the first pass says something, not
part of it.

## Task source

### Primary: SWE-Bench ProMax, TypeScript subset

170 instances drawn from real commits across seven languages, 28 of them
TypeScript. Chosen for four reasons.

**It is the only public suite found that deliberately excludes narrow tasks.**
Instances average 11.4 modified files and 261.6 lines changed; tasks with
insufficient complexity or limited cross-file scope were filtered out during
curation. That is the regime the first suite failed to reach, and the only one
where delegation has anything to amortize against.

**It grades mechanically.** Each instance carries `image_name`, `eval_script`,
`test_patch` and a gold `patch`. The primary gate needs no judge.

**The best evaluated model resolves 41.2%.** This matters more than it appears.
A suite everything passes cannot show a quality difference, and neither can one
nothing passes. Around 40% is where a pass-rate comparison has resolution.

**The gold patch enables reference-anchored judging**, which is substantially
more reliable than open-ended scoring. See below.

Instance fields, per the dataset card: `instance_id`, `repo`, `language`,
`problem_statement`, `hints_text`, `base_commit`, `environment_setup_commit`,
`patch`, `test_patch`, `image_name`, `working_dir`, `created_at`, `eval_script`.

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

The instance's own `eval_script` passes, and nothing that passed before
regresses. Binary. This is the resolve rate and the denominator for cost per
resolved instance.

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

**Calibrate the judge's own noise.** Include identical-pair controls: the same
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
- **Spend split** — orchestrator tokens against worker tokens, for the `swarm`
  arm. This is what says whether the saving came from cheap workers or was eaten
  by the parent reading their reports.

Cost capture is already solved and needs no new instrumentation: the
`worker_graph` tool reports worker usage back through Pi's tool-usage channel,
so one `get_session_stats` call on the parent covers orchestrator and workers
together. Verified: a run whose workers spent 22,253 tokens reported 31,854 on
the parent, the difference being orchestration overhead.

## Preconditions on a valid trial

A trial that did not administer the treatment must not be scored as evidence
against it. Before a `swarm` trial counts:

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

**"Quality stayed the same" is an equivalence claim, not a difference claim**,
and equivalence needs more samples than difference. At n=28 with a ~41% base
rate, the interval on a single arm's resolve rate is roughly ±18 points. That
cannot distinguish "identical" from "fifteen points worse". Reporting "no
difference detected" as "quality is equal" would be the central dishonesty
available in this experiment.

Two levers against it:

**Pre-register a non-inferiority margin** before any trial runs, so the
threshold is not chosen after seeing the numbers.

An absolute margin in points is the wrong shape for it. The FDA's guidance on
choosing one puts the choice in two steps: **M1**, the whole effect the control
is presumed to have, and **M2**, the largest part of M1 it would be acceptable
to give up. The `doer` arm is already what supplies M1 here — it is the floor,
and the orchestrator's entire value is `thinker` minus `doer`. If `thinker`
resolves 41% and `doer` resolves 30%, M1 is 11 points, and the placeholder
10-point margin would let `swarm` surrender 91% of everything the expensive
orchestrator buys and still be called non-inferior. Five points surrenders 45%
of it. Neither number means what it looks like until it is read against M1.

So the margin is a **retention fraction of M1**: `swarm` is non-inferior if it
retains at least *f* of the `thinker`-over-`doer` effect. Pre-register *f*.

M1 is unknown until the bench runs, which is the one place this departs from
the drug-trial procedure — there, M1 comes from historical trials of the active
control, and here there is no history. Two consequences, both of which have to
be accepted openly rather than resolved: the acceptance threshold in points is
only computable after the arms have run, and a bench where `thinker` and `doer`
turn out to be close has no M1 worth retaining a fraction of, which is itself
the finding that the orchestrator bought nothing. Pre-register a fallback
absolute cap alongside *f* to cover the second case, so a vanishing M1 does not
turn into an arbitrarily easy pass.

**Power, and what it rules out.** `bench/power.py` simulates a bench where the
two arms are truly equal and reports how often it would correctly conclude
non-inferiority. At one-sided 95% and 20% discordance:

| margin | n=28 binary | n=28, R=3 graded | n=56, R=3 | n=112, R=3 |
| --- | --- | --- | --- | --- |
| 5 points | 0.19 | 0.19 | 0.26 | 0.40 |
| 10 points | 0.39 | 0.42 | 0.63 | 0.88 |
| 15 points | 0.60 | 0.68 | 0.91 | 0.99 |
| 20 points | 0.78 | 0.88 | 0.99 | 1.00 |

The smallest margin reaching 80% power at n=28 is 21 points on binary McNemar
and about 17 using per-instance pass fractions. Five points would need roughly
450 instances.

This is the decisive constraint on the whole design, and it is worse than it
looks. M1 is plausibly 10 to 15 points. The margin 28 instances can afford is
17 to 21. **The margin is wider than the effect it exists to protect**, so at
this sample size the non-inferiority claim is not available at any value that
means anything — a 20-point margin is one the arm cannot fail.

Two things follow.

**The 28-instance run is a pilot, not a confirmatory trial.** Its job is to
measure M1 and the discordance rate, which is what sizes the real one. It
reports the observed gap with an interval and states that non-inferiority was
not tested. Calling an underpowered pass a demonstration of equal quality is
the dishonesty this section exists to prevent, and it is available at n=28 in
exactly this form.

**Score the graded outcome, not the binary.** Per-instance pass fraction over
the three repetitions costs nothing extra — the repetitions are already
budgeted — and moves the achievable margin from 21 points to about 17. Keep
McNemar on the binary as a secondary, since it is the comparable number.

**The cost claim is not subject to any of this.** A 17-to-20x price gap is
large and low-variance, and n=28 establishes it comfortably. Only the quality
guarantee is underpowered. Report cost as a measurement and quality as a bound,
rather than letting the weaker half set the tone for both.

**Pair by instance and analyze discordant pairs.** Between-instance difficulty
variance dominates everything else here. Comparing two independent rates throws
that away; McNemar over per-instance paired outcomes removes it and buys back
substantial power at the same n. Run every arm on every instance.

If the margin still cannot be resolved at 28 instances, extend from the top-up
pools rather than narrowing the claim after the fact.

Repetitions: Pi exposes no seed, and run-to-run variance was large on the first
suite. Budget at least three repetitions per instance per arm, and treat a
single repetition as a smoke test rather than a measurement.

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

Has to be built:

- **Container setup.** ProMax needs a per-instance Docker environment
  (`image_name`, `environment_setup_commit`, `working_dir`). `gitInit` on a
  temporary folder is replaced by starting the instance's container and running
  the agent against that checkout. This is the bulk of the work.
- **`eval_script` grading**, applying `test_patch` only after the agent has
  finished.
- **The Tier-2 judge**, including order swapping, blinding, and identical-pair
  controls.
- **Paired analysis**: McNemar over discordant pairs, and cost per resolved
  instance.

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

Two consequences for the `swarm` arm. Its parent carries a block the other two
arms do not, so a few hundred tokens of the arm's cost are the mechanism's own
and should not be mistaken for orchestration overhead. And the block marks a
profile read-only when no tool it holds can change the checkout, which is a
nudge toward a particular `review.profile` choice. Open decision 1 settles that
the reviewer runs `sol` on read-only tools, so the nudge and the arm agree; had
the reviewer been given a writable profile, the block would not have endorsed
it and the disagreement would have belonged in the disclosure.

**Judge-blind failure.** If the identical-pair controls show high bias, Tier 2
is uninformative and must be reported as such rather than quietly used anyway.

## Open decisions

1. ~~**Reviewer model.**~~ **Settled: `sol` reviews `luna`.** Faithful to
   thinker-plus-doer, and the alternative — `luna` reviewing `luna` — risks a
   rubber stamp, which would make the review arm meaningless rather than merely
   cheap. The cost is the known one: the thinker reads all the work anyway, so
   review spend may erase part of the saving. That is now a result to measure
   rather than a decision to make, and the **spend split** metric is what
   reports it — if reviewer tokens dominate the `swarm` arm, the saving was
   eaten by the parent.

   The reviewer profile takes `sol` as its model and read-only tools: `read`,
   `grep`, `find`, `ls`. Model and tools are independent, so this keeps the
   package's read-only marking pointing at the reviewer the arm intends.
2. **Review rounds.** `maxRounds` of 2 is the cheap default. Whether 3 buys
   anything is measurable and unmeasured.
3. ~~**Non-inferiority margin.**~~ **Settled: f = 0.5, absolute cap 10
   points.** `swarm` must retain half the `thinker`-over-`doer` effect, and in
   no case fall more than 10 points behind `thinker`. Neither is testable at 28
   instances — see **Statistical design** — which is why the first run is a
   pilot that measures M1 and discordance and sizes the confirmatory run from
   them. The numbers are pre-registered here so that sizing cannot quietly
   become a choice of margin.
4. **Whether `swarm` gets the orchestrator prompt guidance on fan-out.** The
   first suite showed models collapsing independent work into one worker. The
   package ships its own fan-out guidance in the tool's prompt guidelines; any
   strengthening on top of that is arm configuration and must be disclosed,
   and it is the last remaining place where the harness could put words in the
   orchestrator's mouth.

## Unverified

Stated so nobody builds on them as though they were checked:

- how `eval_script` reports pass and fail, and whether ProMax carries
  fail-to-pass / pass-to-pass semantics — the dataset card does not document
  those fields;
- whether the TypeScript instances' containers are npm-shaped and pull cleanly;
- the actual per-instance runtime and container size, which set the cost and
  wall-clock budget for the whole run.

A feasibility spike on a single TypeScript instance settles all three and should
precede any harness work.

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
