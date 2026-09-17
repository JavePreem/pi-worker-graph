/**
 * Reading the store. Asked for deliberately, and never on the way to something
 * else.
 *
 * `status` is what may be consulted between runs; this is not. Deciding to
 * continue after seeing the quality gap is repeated testing of accumulating
 * data, so the gap lives here, behind a command that has to be typed.
 *
 * Everything is computed over **complete tasks** -- a task every arm has
 * settled at the same repetition. Pairing is the whole basis of the
 * statistics: between-task difficulty swamps the effect under test, so an
 * unpaired task is noise rather than information.
 */
import { cellKey, completeTasks } from "./queue.mjs";

/** Records keyed by cell, for the tasks every arm has finished. */
export function pairedRecords(manifest, records) {
  const complete = new Set(
    completeTasks(manifest, records).map((t) => `${t.task}|${t.repetition}`),
  );
  const byCell = new Map();
  for (const record of records) {
    if (record.class === "not-attempted") continue;
    if (!complete.has(`${record.cell.task}|${record.cell.repetition}`))
      continue;
    byCell.set(cellKey(record.cell), record);
  }
  return byCell;
}

export function resolveRates(manifest, records) {
  const paired = pairedRecords(manifest, records);
  const rates = {};
  for (const arm of manifest.arms) {
    const own = [...paired.values()].filter((r) => r.cell.arm === arm);
    const resolved = own.filter((r) => r.class === "resolved").length;
    rates[arm] = {
      n: own.length,
      resolved,
      rate: own.length === 0 ? null : resolved / own.length,
      // Degenerate cells are reported alongside rather than dropped: a model
      // that declined to fan out is a finding about the prompt surface, and
      // burying it in a pass rate is how the first suite went wrong.
      degenerate: own.filter((r) => r.preconditions && !r.preconditions.met)
        .length,
    };
  }
  return rates;
}

/**
 * Two-sided exact McNemar over the discordant pairs. Exact rather than the
 * chi-square approximation because the discordant counts here are small --
 * roughly 20% of two dozen tasks -- and the approximation is not trustworthy
 * there.
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  const logFactorial = (k) => {
    let total = 0;
    for (let i = 2; i <= k; i++) total += Math.log(i);
    return total;
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) {
    const logChoose = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
    tail += Math.exp(logChoose + n * Math.log(0.5));
  }
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

/** The discordant pairs between two arms, which is what McNemar reads. */
export function pairedComparison(manifest, records, armA, armB) {
  const paired = pairedRecords(manifest, records);
  let onlyA = 0;
  let onlyB = 0;
  let both = 0;
  let neither = 0;
  for (const { task, repetition } of completeTasks(manifest, records)) {
    const a = paired.get(cellKey({ task, arm: armA, repetition }));
    const b = paired.get(cellKey({ task, arm: armB, repetition }));
    if (!a || !b) continue;
    const ar = a.class === "resolved";
    const br = b.class === "resolved";
    if (ar && br) both++;
    else if (ar) onlyA++;
    else if (br) onlyB++;
    else neither++;
  }
  return {
    armA,
    armB,
    both,
    neither,
    onlyA,
    onlyB,
    ...mcnemarExact(onlyA, onlyB),
  };
}

/**
 * Everything the arm spent on the stratum, over the instances it actually
 * resolved. It charges failures and retries to the arm that incurred them,
 * which cost per attempt does not.
 */
export function costPerResolved(manifest, records) {
  const paired = pairedRecords(manifest, records);
  const out = {};
  for (const arm of manifest.arms) {
    const own = [...paired.values()].filter((r) => r.cell.arm === arm);
    const spend = own.reduce((total, r) => total + (r.costUsd ?? 0), 0);
    const resolved = own.filter((r) => r.class === "resolved").length;
    out[arm] = {
      spendUsd: Number(spend.toFixed(4)),
      resolved,
      costPerResolvedUsd:
        resolved === 0 ? null : Number((spend / resolved).toFixed(4)),
    };
  }
  return out;
}

/**
 * How much of a `graph` cell's spend went to its worker graphs rather than to
 * the orchestrator. This is the ratio that caps every cost claim: if the
 * expensive side dominates, the saving cheap workers can buy is whatever is
 * left, however cheap they are.
 *
 * **It is not the worker share, and cannot be.** The tool reports one cost per
 * node, and a node's accounting sums every round of its work-review-repair
 * cycle into a single attempt (D20). The reviewer runs `sol` while the worker
 * runs `luna`, so each node's figure is a blend of the two. Measured on the
 * first live `graph-luna` cell, the implied prices were $1.12/M input and
 * $8.10/M output -- between `luna`'s $0.20/$1.20 and `sol`'s $4.00/$20.00, and
 * matching neither. Separating them needs per-role accounting the package does
 * not expose, or an arm configured without review to calibrate against.
 *
 * Returns null when the tool's accounting could not be read. Unknown and zero
 * are kept apart on purpose -- a cell whose node spend is unreadable is not a
 * cell whose workers were free.
 */
const REPORTS_BLOCK =
  /<worker_graph_reports_json>\s*(\[[\s\S]*?\])\s*<\/worker_graph_reports_json>/;

/**
 * The reports the tool returned, from result text that is prose wrapping a
 * tagged JSON block rather than a JSON document.
 *
 * An earlier version parsed the whole text as JSON and looked for `nodes` or
 * `reviews` on it. Neither is what the tool emits, so every real cell came
 * back unreadable -- safely, but the metric never worked. A bare array is
 * still accepted, because that is what a caller supplying its own results
 * would most likely pass.
 */
export function parseWorkerReports(text) {
  if (typeof text !== "string") return [];
  const block = REPORTS_BLOCK.exec(text);
  const json = block === null ? text : block[1];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
    const nodes = parsed?.nodes ?? parsed?.reviews;
    return Array.isArray(nodes) ? nodes : [];
  } catch {
    return [];
  }
}

export function spendSplit(record) {
  const texts = record.detail?.workerGraphResults;
  if (!Array.isArray(texts) || texts.length === 0) return null;
  let nodeCost = 0;
  let read = false;
  for (const text of texts) {
    for (const node of parseWorkerReports(text)) {
      const cost = node?.usage?.cost?.total;
      if (typeof cost === "number") {
        nodeCost += cost;
        read = true;
      }
    }
  }
  if (!read) return null;
  const total = record.costUsd;
  const share =
    typeof total === "number" && total > 0 ? nodeCost / total : null;
  return {
    nodeCostUsd: Number(nodeCost.toFixed(4)),
    totalCostUsd: total,
    // Worker and reviewer together: see above.
    nodeShare: share === null ? null : Number(share.toFixed(4)),
    // A share above 1 is arithmetically impossible and means the two sides
    // disagree, so it is surfaced rather than averaged into a headline. Seen
    // on the first live cell: nodes summed to $2.05 against a session total of
    // $1.39, while the token counts reconciled exactly.
    inconsistent: share !== null && share > 1,
  };
}

export function spendSplitReport(manifest, records) {
  const out = {};
  for (const arm of manifest.arms) {
    const own = records.filter(
      (r) => r.cell.arm === arm && r.class !== "not-attempted",
    );
    const splits = own.map(spendSplit).filter((s) => s !== null);
    out[arm] = {
      cells: own.length,
      readable: splits.length,
      // Named rather than averaged away: a cell whose accounting could not be
      // read is reported as unreadable, not as one with no worker spend.
      unreadable: own.length - splits.length,
      // Cells whose two sides disagree are counted, not averaged in: a share
      // above 1 is arithmetically impossible and means the accounting is
      // wrong somewhere, which is a finding rather than a data point.
      inconsistent: splits.filter((s) => s.inconsistent).length,
      // Worker and reviewer together. `spendSplit` explains why they cannot
      // be separated from what the tool reports.
      meanNodeShare: (() => {
        const usable = splits.filter(
          (s) => !s.inconsistent && s.nodeShare !== null,
        );
        return usable.length === 0
          ? null
          : Number(
              (
                usable.reduce((t, s) => t + s.nodeShare, 0) / usable.length
              ).toFixed(4),
            );
      })(),
    };
  }
  return out;
}

/**
 * The whole reading, with the caveat attached rather than left to the reader.
 * Everything short of a confirmatory trial is a pilot: its job is to measure
 * M1 and the discordance rate that size the real one, and a pass at this
 * sample size is not a demonstration of equal quality.
 */
export function analyse(manifest, records) {
  const complete = completeTasks(manifest, records);
  const rates = resolveRates(manifest, records);
  const comparisons = [
    ["solo-sol", "graph-sol"],
    ["graph-sol", "graph-luna"],
    ["solo-sol", "graph-luna"],
    ["solo-sol", "solo-luna"],
  ]
    .filter(([a, b]) => manifest.arms.includes(a) && manifest.arms.includes(b))
    .map(([a, b]) => pairedComparison(manifest, records, a, b));

  // M1 needs both arms. An arm that is absent or has finished no paired task
  // leaves it unknown rather than treating its rate as zero, which would
  // manufacture an effect out of a missing measurement.
  const solo = rates["solo-sol"]?.rate;
  const floor = rates["solo-luna"]?.rate;
  const m1 =
    typeof solo === "number" && typeof floor === "number"
      ? Number((solo - floor).toFixed(4))
      : null;

  return {
    completeTasks: complete.length,
    resolveRates: rates,
    comparisons,
    costPerResolved: costPerResolved(manifest, records),
    spendSplit: spendSplitReport(manifest, records),
    // M1 is the whole effect the expensive orchestrator is presumed to buy.
    // The non-inferiority margin is a fraction of it, so a vanishing M1 is
    // itself the finding that the orchestrator bought nothing.
    m1: m1,
    nonInferiorityTested: false,
    caveat:
      "Pilot. Non-inferiority is not tested at this sample size: the margin " +
      "28 instances can afford is wider than the effect it exists to protect. " +
      "Report the observed gap with its interval, not as equal quality.",
  };
}
