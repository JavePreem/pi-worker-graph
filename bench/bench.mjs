#!/usr/bin/env node
/**
 * The bench, as three commands over one store.
 *
 *   init      draw the task order and record it, once
 *   status    spend, projected spend, complete tasks, preconditions
 *   run N     execute the next N pending cells
 *   analyse   the reading, asked for deliberately
 *
 * `status` is what may be consulted between runs. `analyse` is not: deciding
 * whether to continue after seeing the quality gap is repeated testing of
 * accumulating data. See DESIGN.md "Accumulation".
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyse } from "./analyse.mjs";
import { runCell } from "./cell.mjs";
import { gradeableInstances, loadInstances } from "./dataset.mjs";
import { createManifest, pendingCells, statusReport } from "./queue.mjs";
import {
  appendRecord,
  readManifest,
  readRecords,
  writeManifest,
} from "./store.mjs";
import { prepareToolchain, readAgentSettings } from "./toolchain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.BENCH_STORE ?? path.join(HERE, "store");
const AGENT_DIR =
  process.env.BENCH_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
const TOOLCHAIN = process.env.BENCH_TOOLCHAIN ?? path.join(HERE, ".toolchain");

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function harnessVersion() {
  const pkg = JSON.parse(
    await readFile(path.join(HERE, "..", "package.json"), "utf8"),
  );
  return `bench@${pkg.version}`;
}

async function init() {
  const { gradeable, dropped } = await gradeableInstances();
  if (gradeable.length === 0)
    throw new Error("no gradeable instances; run validate-instances.py");

  // The permutation is drawn once and cannot be extended, so a pool that is
  // still being validated would silently become the whole experiment. Finish
  // the sweep, or say explicitly that the smaller pool is the intent.
  const instances = await loadInstances();
  const subset = [...instances.values()].filter(
    (row) =>
      row.language.toLowerCase() ===
      (process.env.BENCH_LANGUAGE ?? "typescript"),
  );
  const unvalidated = subset.length - (gradeable.length + dropped.length);
  if (unvalidated > 0 && !process.argv.includes("--partial-pool")) {
    throw new Error(
      `${unvalidated} of ${subset.length} instances are not validated yet. ` +
        "The task order is drawn once and cannot be extended: finish " +
        "validate-instances.py, or pass --partial-pool to fix the order over " +
        "the smaller pool deliberately.",
    );
  }
  const seed = Number(flag("seed", String(Date.now() % 2 ** 31)));
  const manifest = createManifest({
    taskIds: gradeable.map((i) => i.id),
    seed,
    repetitions: Number(flag("repetitions", "1")),
    // graph-sol is about half the budget. Capping it to a prefix is a weaker
    // machinery screen rather than a missing one, which is the only trade the
    // design permits against the budget.
    armPrefix:
      flag("graph-sol-prefix") === undefined
        ? {}
        : { "graph-sol": Number(flag("graph-sol-prefix")) },
    harnessVersion: await harnessVersion(),
    packageVersion: flag("package", "pi-worker-graph@latest"),
    provider:
      process.env.BENCH_PROVIDER ??
      (await readAgentSettings(AGENT_DIR)).defaultProvider,
  });
  const paths = await writeManifest(STORE, manifest);
  console.log(
    `${manifest.order.length} tasks, seed ${seed}, ${dropped.length} dropped`,
  );
  console.log(
    `${pendingCells(manifest, []).length} cells -> ${paths.manifest}`,
  );
}

async function status() {
  const manifest = await readManifest(STORE);
  const records = await readRecords(STORE);
  console.log(JSON.stringify(statusReport(manifest, records), null, 2));
}

async function run(count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("run needs a positive cell count");
  const manifest = await readManifest(STORE);
  const records = await readRecords(STORE);
  const { gradeable } = await gradeableInstances();
  const byId = new Map(gradeable.map((i) => [i.id, i]));
  const queue = pendingCells(manifest, records).slice(0, count);
  if (queue.length === 0) {
    console.log("nothing pending");
    return;
  }

  const toolchain = await prepareToolchain({
    dir: TOOLCHAIN,
    piSpec: flag("pi", "@earendil-works/pi-coding-agent@0.85.1"),
    packageSpec: flag("package-spec", "pi-worker-graph@latest"),
  });
  console.log(
    `pi ${toolchain.piVersion}, pi-worker-graph ${toolchain.packageVersion}`,
  );
  if (toolchain.packageVersion !== undefined) {
    // The store says which package a cell measured, because a task re-run
    // under a different version is a different measurement.
    manifest.packageVersion = `pi-worker-graph@${toolchain.packageVersion}`;
  }

  // The provider is read from the agent directory that actually holds the
  // credentials, rather than assumed: a bench that names the wrong one fails
  // every cell at `set_model` and says nothing about why.
  const settings = await readAgentSettings(AGENT_DIR);
  const provider = process.env.BENCH_PROVIDER ?? settings.defaultProvider;
  if (provider === undefined) {
    throw new Error(
      `no defaultProvider in ${AGENT_DIR}/settings.json; set BENCH_PROVIDER`,
    );
  }
  console.log(`provider ${provider}`);

  const cap = flag("cap") === undefined ? undefined : Number(flag("cap"));
  for (const [index, cell] of queue.entries()) {
    console.log(
      `\n[${index + 1}/${queue.length}] ${cell.task} ${cell.arm} r${cell.repetition}`,
    );
    const record = await runCell({
      instance: byId.get(cell.task),
      cell,
      manifest,
      agentDirectorySource: AGENT_DIR,
      toolchainDir: toolchain.dir,
      packageTree: toolchain.packageTree,
      packageVersion: toolchain.packageVersion,
      provider,
      capUsd: cap,
    });
    await appendRecord(STORE, record);
    console.log(
      `  => ${record.class} (${record.outcome}) $${record.costUsd ?? "?"}`,
    );
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "init") return init();
  if (command === "status") return status();
  if (command === "run") return run(Number(process.argv[3]));
  if (command === "analyse") {
    const manifest = await readManifest(STORE);
    console.log(
      JSON.stringify(analyse(manifest, await readRecords(STORE)), null, 2),
    );
    return;
  }
  console.log("usage: bench.mjs init|status|run <count>|analyse");
  process.exitCode = 1;
}

// A stack trace tells the operator nothing a bench command can go wrong
// about. The message is the whole diagnosis.
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
