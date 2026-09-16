#!/usr/bin/env node
import { existsSync } from "node:fs";
/**
 * Proves the grading path without spending anything on a provider.
 *
 * It runs a cell with the gold patch standing in for the agent: start the
 * instance's container, apply `patch`, then grade exactly as a real cell will.
 * A gold patch that does not grade as resolved means the harness is wrong, not
 * the model, and that is a mistake worth catching before any arm is bought.
 *
 * Usage: node bench/grade-selftest.mjs [instance-id ...]
 * With no ids, every gradeable instance is checked, which is a long run --
 * BENCH_RMI=1 drops each image after its instance.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPatch,
  awaitHeadroom,
  pullImage,
  removeImage,
  startContainer,
} from "./container.mjs";
import { gradeableInstances } from "./dataset.mjs";
import { gradeTier1 } from "./grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.BENCH_SELFTEST_RESULTS ??
  path.join(HERE, "selftest-results.json");

const { gradeable, dropped } = await gradeableInstances();
const requested = process.argv.slice(2);
const selected = requested.length
  ? gradeable.filter((i) => requested.includes(i.id))
  : gradeable;

// Resumable for the same reason the validation sweep is: a run is hours long
// and the host can only carry an instance or two at a time.
const results = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : [];
const done = new Set(results.map((r) => r.instance_id));
const pending = selected.filter((i) => !done.has(i.id));

console.log(
  `${gradeable.length} gradeable, ${dropped.length} dropped, ` +
    `${done.size} checked, ${pending.length} to check -> ${OUT}`,
);

for (const instance of pending) {
  console.log(`\n${"=".repeat(70)}\n${instance.id}`);
  await awaitHeadroom({
    onWait: (kb, giveUp) =>
      console.log(
        giveUp
          ? `  only ${Math.round(kb / 1024)} MB available; continuing anyway`
          : `  ${Math.round(kb / 1024)} MB available, waiting`,
      ),
  });
  const started = Date.now();
  const record = { instance_id: instance.id, targets: instance.targets };
  const name = `selftest_${instance.id.replace(/[^a-z0-9]/gi, "_").slice(-40)}`;
  let container;
  try {
    await pullImage(instance.row.image_name);
    container = await startContainer(instance.row.image_name, { name });

    const gold = await applyPatch(container, instance.row.patch, {
      label: "gold_patch",
    });
    if (!gold.applied) {
      record.outcome = "gold-patch-apply-failed";
      record.detail = gold.detail;
    } else {
      const graded = await gradeTier1(container, {
        testPatch: instance.row.test_patch,
        targets: instance.targets,
        regressionTargets: instance.regressionTargets,
      });
      record.outcome = graded.outcome;
      record.resolved = graded.resolved;
      record.states = Object.fromEntries(
        Object.entries(graded.states).map(([t, s]) => [
          t,
          `${s.state}: ${s.reason}`,
        ]),
      );
      if (graded.detail) record.detail = graded.detail;
    }
  } catch (error) {
    record.outcome = "harness";
    record.detail = String(error).slice(0, 400);
  } finally {
    await container?.stop();
    if (process.env.BENCH_RMI === "1")
      await removeImage(instance.row.image_name);
  }
  record.total_s = Math.round((Date.now() - started) / 1000);
  console.log(`  => ${record.outcome} (${record.total_s}s)`);
  results.push(record);
  await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
}

const resolved = results.filter((r) => r.resolved).length;
console.log(
  `\n${"=".repeat(70)}\n${resolved}/${results.length} gold patches graded as resolved`,
);
if (resolved !== results.length) {
  console.log("Not resolved:");
  for (const r of results.filter((x) => !x.resolved)) {
    console.log(`  ${r.instance_id}: ${r.outcome} ${r.detail ?? ""}`);
  }
  process.exitCode = 1;
}
