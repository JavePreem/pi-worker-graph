/**
 * The queue and its store.
 *
 * The bench is not a run, it is a queue: every cell is enumerated up front in
 * a fixed order, the store records which ones are done, and a run executes as
 * many of the next pending ones as it is asked for. What makes three cells now
 * and nine later add up is that the order was drawn before the first cell and
 * nothing after it consults a result. See DESIGN.md "Accumulation".
 */

export const SCHEMA = 1;

/**
 * Cells terminate into exactly these three. Only the first two enter the
 * resolve rate; the third is a harness failure -- a container that would not
 * start, a provider 500, a cell stopped by its spend cap -- and charging an
 * arm for one of those would be charging it for the weather.
 */
export const CLASSES = ["resolved", "not-resolved", "not-attempted"];

export const ARMS = ["solo-sol", "graph-sol", "graph-luna", "solo-luna"];

/**
 * Deterministic from the seed, so the order can be recomputed and checked
 * rather than trusted. mulberry32: small, and its quality is irrelevant here --
 * what matters is that the draw happened before any result existed.
 */
function shuffle(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The permutation, fixed before the first cell runs and recorded in the store.
 * `armPrefix` caps an arm to the first N tasks: `graph-sol` is about half the
 * budget, and running it on a prefix is a weaker machinery screen rather than
 * a missing one.
 */
export function createManifest({
  taskIds,
  seed,
  arms = ARMS,
  repetitions = 1,
  armPrefix = {},
  harnessVersion,
  packageVersion,
  provider,
}) {
  if (!taskIds?.length) throw new Error("a manifest needs at least one task");
  if (!Number.isInteger(seed))
    throw new Error("a manifest needs an integer seed");
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    seed,
    arms: [...arms],
    repetitions,
    armPrefix: { ...armPrefix },
    order: shuffle(taskIds, seed),
    harnessVersion,
    packageVersion,
    // Which provider served the models is an account fact rather than a design
    // one, and a store that does not say which one it used cannot be compared
    // with another. Omitted rather than left undefined, so a manifest survives
    // its own JSON round trip unchanged.
    ...(provider === undefined ? {} : { provider }),
  };
}

/**
 * Every cell, in execution order: a task's arms are adjacent, and every task
 * is enumerated at repetition 1 before any task at repetition 2. Tasks before
 * repetitions -- twice the tasks covers twice the ground at the same power.
 */
export function enumerateCells(manifest) {
  const cells = [];
  for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
    manifest.order.forEach((task, taskIndex) => {
      for (const arm of manifest.arms) {
        const prefix = manifest.armPrefix?.[arm];
        if (prefix !== undefined && taskIndex >= prefix) continue;
        cells.push({ task, arm, repetition });
      }
    });
  }
  return cells;
}

/**
 * Refuse a run served by a different provider than the manifest recorded.
 *
 * `BENCH_PROVIDER` is an environment variable, so forgetting it on the second
 * sitting silently falls back to the agent directory's default. Cells would
 * then be measured against two rate cards inside one paired analysis, and
 * nothing in a record says which one served it beyond this field. The pairing
 * is the basis of every figure here, so the mismatch fails closed.
 */
export function assertProviderMatches(manifest, provider) {
  if (manifest.provider === undefined || manifest.provider === provider) return;
  throw new Error(
    `this store was drawn against provider "${manifest.provider}" but the ` +
      `run resolves to "${provider}". Set BENCH_PROVIDER=${manifest.provider}, ` +
      "or start a separate store: cells served by two providers cannot be " +
      "paired against each other.",
  );
}

export function cellKey({ task, arm, repetition }) {
  return JSON.stringify([task, arm, repetition]);
}

/**
 * Pending means no record, or a record classed not-attempted. Those are the
 * only ones eligible for re-running: a resolved or not-resolved cell is a
 * measurement, and re-running it under a changed version would silently mix
 * the store.
 */
export function pendingCells(manifest, records) {
  const settled = new Set(
    records
      .filter((r) => r.class !== "not-attempted")
      .map((r) => cellKey(r.cell)),
  );
  return enumerateCells(manifest).filter((cell) => !settled.has(cellKey(cell)));
}

/**
 * A task counts only when every arm has settled it at the same repetition.
 * Pairing is the whole basis of the statistics -- between-task difficulty
 * swamps everything else -- so an unpaired task is noise rather than
 * information, and stopping mid-task simply leaves it uncounted.
 */
export function completeTasks(manifest, records) {
  const settled = new Set(
    records
      .filter((r) => r.class !== "not-attempted")
      .map((r) => cellKey(r.cell)),
  );
  const all = enumerateCells(manifest);
  const complete = [];
  for (const task of manifest.order) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
      const required = all.filter(
        (c) => c.task === task && c.repetition === repetition,
      );
      if (
        required.length > 0 &&
        required.every((c) => settled.has(cellKey(c)))
      ) {
        complete.push({ task, repetition });
      }
    }
  }
  return complete;
}

/**
 * What may be looked at between runs.
 *
 * Deliberately does not carry a resolve rate, a per-arm outcome count, or any
 * other form of the quality gap. Deciding to continue after seeing the gap is
 * repeated testing of accumulating data, and it inflates the false-positive
 * rate past the nominal 5%. Cost and preconditions are not the outcome under
 * test, so they may drive the decision; the gap may not. It reports raw spend
 * rather than cost per resolved instance for the same reason -- the composite
 * would leak the gap through its denominator.
 */
export function statusReport(manifest, records) {
  const settled = records.filter((r) => r.class !== "not-attempted");
  const spendByArm = {};
  for (const record of settled) {
    spendByArm[record.cell.arm] =
      (spendByArm[record.cell.arm] ?? 0) + (record.costUsd ?? 0);
  }
  const spend = Object.values(spendByArm).reduce((a, b) => a + b, 0);
  const pending = pendingCells(manifest, records);
  const meanCell = settled.length > 0 ? spend / settled.length : null;
  return {
    completeTasks: completeTasks(manifest, records).length,
    settledCells: settled.length,
    pendingCells: pending.length,
    spendUsd: Number(spend.toFixed(4)),
    spendByArm,
    projectedRemainingUsd:
      meanCell === null ? null : Number((meanCell * pending.length).toFixed(2)),
    notAttempted: records
      .filter((r) => r.class === "not-attempted")
      .map((r) => ({ cell: r.cell, reason: r.outcome })),
    // Preconditions are a finding about the prompt surface, not a loss, and a
    // graph arm that never fanned out invalidates its own cell.
    degenerate: settled
      .filter((r) => r.preconditions && !r.preconditions.met)
      .map((r) => ({ cell: r.cell, failed: r.preconditions.failed })),
    versions: [
      ...new Set(settled.map((r) => `${r.harnessVersion}/${r.packageVersion}`)),
    ],
  };
}

/**
 * One record, written once, after the run has settled and been graded. A crash
 * mid-cell leaves nothing, so a resumed run re-runs the cell rather than
 * inheriting half of one.
 */
export function makeRecord({
  cell,
  cellClass,
  outcome,
  manifest,
  usage,
  costUsd,
  preconditions,
  diff,
  detail,
}) {
  if (!CLASSES.includes(cellClass))
    throw new Error(`unknown cell class: ${cellClass}`);
  return {
    schema: SCHEMA,
    cell,
    class: cellClass,
    outcome,
    usage,
    costUsd,
    preconditions,
    diff,
    detail,
    harnessVersion: manifest.harnessVersion,
    packageVersion: manifest.packageVersion,
    recordedAt: new Date().toISOString(),
  };
}
