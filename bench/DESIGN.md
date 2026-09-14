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

**Pre-register a non-inferiority margin** before any trial runs — "swarm is
acceptable if its resolve rate is within 10 points of thinker" — so the
threshold is not chosen after seeing the numbers.

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

**The profile-discovery gap.** The `worker_graph` schema requires a profile name
"from the global worker-graph configuration" and nothing enumerates the
available names, so an orchestrator guesses and every graph is rejected with
`Worker profile is invalid`. The first suite compensated with a one-line
`--append-system-prompt` naming the profile, and the new harness will need the
same patch. It must stay documented as a confound until the package closes the
gap, because it is scaffolding around a real defect rather than part of the
experiment. The defect is recorded under "Known defects" in `docs/NEXT.md`.

**Judge-blind failure.** If the identical-pair controls show high bias, Tier 2
is uninformative and must be reported as such rather than quietly used anyway.

## Open decisions

1. **Reviewer model.** `sol` reviewing `luna`'s work is faithful to thinker-plus-doer
   but expensive — the thinker reads all the work anyway, which may erase the
   saving. `luna` reviewing `luna` is cheap but may rubber-stamp. This needs a
   small pilot before the main run, and it may well be the decisive variable.
2. **Review rounds.** `maxRounds` of 2 is the cheap default. Whether 3 buys
   anything is measurable and unmeasured.
3. **Non-inferiority margin.** 10 points is a placeholder. It must be set,
   deliberately, before the first trial.
4. **Whether `swarm` gets the orchestrator prompt guidance on fan-out.** The
   first suite showed models collapsing independent work into one worker. If the
   guidance is strengthened for the bench, that is arm configuration and must be
   disclosed like the profile-name patch.

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
