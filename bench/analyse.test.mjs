import assert from "node:assert/strict";
import test from "node:test";

import {
  analyse,
  mcnemarExact,
  pairedComparison,
  resolveRates,
  spendSplit,
} from "./analyse.mjs";
import { ARMS, createManifest, makeRecord } from "./queue.mjs";

const manifest = createManifest({
  taskIds: ["t1", "t2"],
  seed: 5,
  harnessVersion: "h",
  packageVersion: "p",
});

const record = (task, arm, resolved, over = {}) =>
  makeRecord({
    cell: { task, arm, repetition: 1 },
    cellClass: resolved ? "resolved" : "not-resolved",
    outcome: resolved ? "resolved" : "unresolved",
    manifest,
    ...over,
  });

/** Every arm settles every task, so both tasks are complete and paired. */
const fullStore = (resolvedBy) =>
  manifest.order.flatMap((task) =>
    ARMS.map((arm) => record(task, arm, resolvedBy(task, arm))),
  );

test("rates are computed only over tasks every arm finished", () => {
  const partial = [record(manifest.order[0], "solo-sol", true)];
  assert.equal(resolveRates(manifest, partial)["solo-sol"].n, 0);

  const whole = fullStore((_, arm) => arm === "solo-sol");
  const rates = resolveRates(manifest, whole);
  assert.equal(rates["solo-sol"].rate, 1);
  assert.equal(rates["solo-luna"].rate, 0);
  assert.equal(rates["solo-sol"].n, 2);
});

test("a degenerate cell is counted beside the rate, not dropped from it", () => {
  const records = fullStore(() => true).map((r) =>
    r.cell.arm === "graph-luna"
      ? {
          ...r,
          preconditions: {
            met: false,
            failed: ["no graph had more than one task"],
          },
        }
      : r,
  );
  const rates = resolveRates(manifest, records);
  assert.equal(rates["graph-luna"].degenerate, 2);
  assert.equal(rates["graph-luna"].n, 2);
});

test("McNemar reads the discordant pairs and nothing else", () => {
  const records = fullStore((task, arm) =>
    arm === "solo-sol" ? true : task !== manifest.order[0],
  );
  const comparison = pairedComparison(
    manifest,
    records,
    "solo-sol",
    "graph-luna",
  );
  assert.equal(comparison.both, 1);
  assert.equal(comparison.onlyA, 1);
  assert.equal(comparison.onlyB, 0);
  assert.equal(comparison.n, 1);
});

test("no discordant pair is no evidence, not a significant result", () => {
  assert.deepEqual(mcnemarExact(0, 0), { b: 0, c: 0, n: 0, p: 1 });
  assert.equal(mcnemarExact(3, 3).p, 1);
  assert.ok(mcnemarExact(10, 0).p < 0.01);
});

test("cost per resolved charges an arm for the instances it failed", () => {
  const records = fullStore(
    (task, arm) => arm === "solo-sol" && task === manifest.order[0],
  ).map((r) => ({ ...r, costUsd: 1 }));
  const report = analyse(manifest, records).costPerResolved;
  assert.equal(report["solo-sol"].spendUsd, 2);
  assert.equal(report["solo-sol"].resolved, 1);
  assert.equal(report["solo-sol"].costPerResolvedUsd, 2);
  assert.equal(report["solo-luna"].costPerResolvedUsd, null);
});

test("an unreadable spend split is unknown rather than zero", () => {
  assert.equal(spendSplit({ costUsd: 1, detail: {} }), null);
  assert.equal(
    spendSplit({ costUsd: 1, detail: { workerGraphResults: ["not json"] } }),
    null,
  );
  assert.equal(
    spendSplit({
      costUsd: 1,
      detail: { workerGraphResults: [JSON.stringify({ nodes: [{}] })] },
    }),
    null,
  );
});

test("a readable spend split is the share that left the expensive model", () => {
  const text = JSON.stringify({
    nodes: [
      { usage: { cost: { total: 0.2 } } },
      { usage: { cost: { total: 0.1 } } },
    ],
  });
  const split = spendSplit({
    costUsd: 1.5,
    detail: { workerGraphResults: [text] },
  });
  assert.equal(split.workerCostUsd, 0.3);
  assert.equal(split.workerShare, 0.2);
});

test("the spend-split report names unreadable cells rather than averaging them away", () => {
  const records = fullStore(() => true).map((r) => ({ ...r, costUsd: 1 }));
  const report = analyse(manifest, records).spendSplit;
  assert.equal(report["graph-luna"].readable, 0);
  assert.equal(report["graph-luna"].unreadable, 2);
  assert.equal(report["graph-luna"].meanWorkerShare, null);
});

test("M1 is the effect the expensive orchestrator is presumed to buy", () => {
  const records = fullStore(
    (task, arm) => arm !== "solo-luna" || task === manifest.order[0],
  );
  const result = analyse(manifest, records);
  assert.equal(result.resolveRates["solo-sol"].rate, 1);
  assert.equal(result.resolveRates["solo-luna"].rate, 0.5);
  assert.equal(result.m1, 0.5);
});

test("the reading says it is a pilot and that non-inferiority was not tested", () => {
  const result = analyse(
    manifest,
    fullStore(() => true),
  );
  assert.equal(result.nonInferiorityTested, false);
  assert.match(result.caveat, /not tested/);
});

test("M1 is unknown when an arm has finished no paired task", () => {
  const withoutFloor = createManifest({
    taskIds: ["t1"],
    seed: 5,
    arms: ["solo-sol", "graph-luna"],
    harnessVersion: "h",
    packageVersion: "p",
  });
  const records = ["solo-sol", "graph-luna"].map((arm) =>
    makeRecord({
      cell: { task: "t1", arm, repetition: 1 },
      cellClass: "resolved",
      outcome: "resolved",
      manifest: withoutFloor,
    }),
  );
  const result = analyse(withoutFloor, records);
  assert.equal(result.resolveRates["solo-sol"].rate, 1);
  // Not 1 - 0. A missing floor is a missing measurement, not a zero one.
  assert.equal(result.m1, null);
});
