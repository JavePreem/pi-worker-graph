import assert from "node:assert/strict";
import test from "node:test";

import {
  ARMS,
  completeTasks,
  createManifest,
  enumerateCells,
  makeRecord,
  pendingCells,
  statusReport,
} from "./queue.mjs";

const manifest = (over = {}) =>
  createManifest({
    taskIds: ["t1", "t2", "t3"],
    seed: 7,
    harnessVersion: "h1",
    packageVersion: "p1",
    ...over,
  });

const settled = (m, cell, over = {}) =>
  makeRecord({
    cell,
    cellClass: "resolved",
    outcome: "resolved",
    manifest: m,
    ...over,
  });

test("the order is a deterministic function of the seed", () => {
  assert.deepEqual(manifest().order, manifest().order);
  assert.notDeepEqual(manifest({ seed: 7 }).order, manifest({ seed: 8 }).order);
});

test("a manifest refuses to exist without a seed", () => {
  assert.throws(() => createManifest({ taskIds: ["t1"] }), /integer seed/);
});

test("a task's arms are adjacent", () => {
  const cells = enumerateCells(manifest());
  const tasks = cells.map((c) => c.task);
  assert.deepEqual(tasks.slice(0, 4), Array(4).fill(tasks[0]));
});

test("every task runs at repetition 1 before any task at repetition 2", () => {
  const cells = enumerateCells(manifest({ repetitions: 2 }));
  const firstSecondRep = cells.findIndex((c) => c.repetition === 2);
  assert.equal(
    cells.slice(0, firstSecondRep).every((c) => c.repetition === 1),
    true,
  );
  assert.equal(firstSecondRep, 3 * ARMS.length);
});

test("an arm prefix caps that arm to the leading tasks and leaves the rest whole", () => {
  const m = manifest({ armPrefix: { "graph-sol": 1 } });
  const cells = enumerateCells(m);
  const graphSol = cells.filter((c) => c.arm === "graph-sol");
  assert.deepEqual(
    graphSol.map((c) => c.task),
    [m.order[0]],
  );
  assert.equal(cells.filter((c) => c.arm === "solo-sol").length, 3);
});

test("a settled cell is not pending again", () => {
  const m = manifest();
  const [first] = enumerateCells(m);
  assert.equal(pendingCells(m, []).length, 12);
  assert.equal(pendingCells(m, [settled(m, first)]).length, 11);
});

test("a not-attempted cell stays pending, because it was never a measurement", () => {
  const m = manifest();
  const [first] = enumerateCells(m);
  const record = makeRecord({
    cell: first,
    cellClass: "not-attempted",
    outcome: "container would not start",
    manifest: m,
  });
  assert.equal(pendingCells(m, [record]).length, 12);
});

test("a task counts only when every arm has settled it", () => {
  const m = manifest();
  const cells = enumerateCells(m);
  const partial = cells.slice(0, 3).map((c) => settled(m, c));
  assert.deepEqual(completeTasks(m, partial), []);
  const whole = cells.slice(0, 4).map((c) => settled(m, c));
  assert.deepEqual(completeTasks(m, whole), [
    { task: m.order[0], repetition: 1 },
  ]);
});

test("an unknown cell class is refused rather than recorded", () => {
  const m = manifest();
  assert.throws(
    () =>
      makeRecord({
        cell: enumerateCells(m)[0],
        cellClass: "failed",
        manifest: m,
      }),
    /unknown cell class/,
  );
});

test("status shows spend and preconditions and never the quality gap", () => {
  const m = manifest();
  const cells = enumerateCells(m);
  const records = [
    settled(m, cells[0], { costUsd: 1.5 }),
    makeRecord({
      cell: cells[1],
      cellClass: "not-resolved",
      outcome: "unresolved",
      manifest: m,
      costUsd: 0.5,
    }),
  ];
  const status = statusReport(m, records);
  assert.equal(status.settledCells, 2);
  assert.equal(status.spendUsd, 2);
  assert.equal(status.completeTasks, 0);
  assert.equal(status.projectedRemainingUsd, 10);

  // The mechanism, not the intention: nothing in the report may carry an
  // outcome count, because continuing after seeing the gap is repeated testing
  // of accumulating data.
  const serialized = JSON.stringify(status);
  for (const leak of ["resolved", "not-resolved", "outcome", "resolveRate"]) {
    assert.equal(serialized.includes(leak), false, `status leaks ${leak}`);
  }
});

test("status reports a not-attempted cell with its reason, apart from the settled ones", () => {
  const m = manifest();
  const cells = enumerateCells(m);
  const status = statusReport(m, [
    makeRecord({
      cell: cells[0],
      cellClass: "not-attempted",
      outcome: "spend cap",
      manifest: m,
    }),
  ]);
  assert.equal(status.settledCells, 0);
  assert.deepEqual(status.notAttempted, [
    { cell: cells[0], reason: "spend cap" },
  ]);
});

test("a degenerate cell is reported as such rather than buried in a pass rate", () => {
  const m = manifest();
  const cells = enumerateCells(m);
  const status = statusReport(m, [
    settled(m, cells[0], {
      cellClass: "not-resolved",
      outcome: "unresolved",
      preconditions: { met: false, failed: ["graphSizes"] },
    }),
  ]);
  assert.deepEqual(status.degenerate, [
    { cell: cells[0], failed: ["graphSizes"] },
  ]);
});

test("a mixed-version store reports as mixed", () => {
  const m = manifest();
  const cells = enumerateCells(m);
  const other = { ...m, packageVersion: "p2" };
  const status = statusReport(m, [
    settled(m, cells[0]),
    settled(other, cells[1]),
  ]);
  assert.deepEqual(status.versions, ["h1/p1", "h1/p2"]);
});
