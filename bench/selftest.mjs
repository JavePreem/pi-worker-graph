#!/usr/bin/env node
/**
 * Proves a suite's grading path without spending anything on a provider.
 *
 * It runs a cell with the suite's reference solution standing in for the
 * agent: start the task's container, prepare its checkout, apply the
 * reference, then grade exactly as a real cell will. A reference that does not
 * grade as resolved means the harness is wrong, not the model, and that is a
 * mistake worth catching before any arm is bought.
 *
 * Usage: node bench/selftest.mjs --suite <name> [task-id ...]
 * With no ids, every task is checked. Results accumulate in
 * `bench/suites/<name>/selftest-results.json`, and a task already recorded
 * there is skipped. BENCH_RMI=1 drops each image after its task.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  awaitHeadroom,
  ensureImage,
  removeImage,
  startContainer,
} from "./container.mjs";
import { loadSuite } from "./suites/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const at = args.indexOf("--suite");
const name = at === -1 ? process.env.BENCH_SUITE : args[at + 1];
if (name === undefined) {
  console.error("usage: selftest.mjs --suite <name> [task-id ...]");
  process.exit(1);
}
const requested =
  at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
const suite = await loadSuite(name);
if (suite.applyReference === undefined) {
  console.error(`suite ${name} has no reference solution to grade`);
  process.exit(1);
}
const OUT =
  process.env.BENCH_SELFTEST_RESULTS ??
  path.join(HERE, "suites", name, "selftest-results.json");

const {
  tasks,
  dropped,
  trialOnly = [],
} = await suite.loadTasks({
  partialPool: true,
});
const all = [...tasks, ...trialOnly];
const selected = requested.length
  ? all.filter((t) => requested.includes(t.id))
  : tasks;

// Resumable: a ProMax run is hours long and the host can only carry an image
// or two at a time.
const results = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : [];
const done = new Set(results.map((r) => r.task));
const pending = selected.filter((t) => !done.has(t.id));

console.log(
  `${tasks.length} tasks, ${dropped.length} dropped, ` +
    `${done.size} checked, ${pending.length} to check -> ${OUT}`,
);

for (const task of pending) {
  console.log(`\n${"=".repeat(70)}\n${task.id}`);
  await awaitHeadroom({
    onWait: (kb, giveUp) =>
      console.log(
        giveUp
          ? `  only ${Math.round(kb / 1024)} MB available; continuing anyway`
          : `  ${Math.round(kb / 1024)} MB available, waiting`,
      ),
  });
  const started = Date.now();
  const record = { task: task.id };
  const containerName = `selftest_${task.id.replace(/[^a-z0-9]/gi, "_").slice(-40)}`;
  let container;
  try {
    await (suite.ensureImage ?? ensureImage)(task.image);
    container = await startContainer(task.image, { name: containerName });
    if (suite.prepare !== undefined) await suite.prepare(container, task);

    const reference = await suite.applyReference(container, task);
    if (!reference.applied) {
      record.outcome = "reference-apply-failed";
      record.detail = reference.detail;
    } else {
      const graded = await suite.grade(container, task);
      record.outcome = graded.outcome;
      record.resolved = graded.resolved;
      record.states = Object.fromEntries(
        Object.entries(graded.states).map(([t, s]) => [
          t,
          `${s.state}: ${s.reason}`,
        ]),
      );
      if (graded.detail) record.detail = graded.detail;
      if (graded.quality) record.quality = graded.quality;
    }
  } catch (error) {
    record.outcome = "harness";
    record.detail = String(error).slice(0, 400);
  } finally {
    await container?.stop();
    if (process.env.BENCH_RMI === "1") await removeImage(task.image);
  }
  record.total_s = Math.round((Date.now() - started) / 1000);
  console.log(`  => ${record.outcome} (${record.total_s}s)`);
  results.push(record);
  await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
}

const resolved = results.filter((r) => r.resolved).length;
console.log(
  `\n${"=".repeat(70)}\n${resolved}/${results.length} references graded as resolved`,
);
if (resolved !== results.length) {
  console.log("Not resolved:");
  for (const r of results.filter((x) => !x.resolved)) {
    console.log(`  ${r.task}: ${r.outcome} ${r.detail ?? ""}`);
  }
  process.exitCode = 1;
}
