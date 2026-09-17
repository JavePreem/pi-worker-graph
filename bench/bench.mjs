#!/usr/bin/env node
/**
 * The bench, as commands over one store.
 *
 *   init            draw the task order and record it, once
 *   status          spend, projected spend, complete tasks, preconditions
 *   run N --cap U   execute the next N pending cells, each capped at $U
 *   analyse         the reading, asked for deliberately
 *   cell <id> <arm> --cap U   one named cell, outside queue and store
 *
 * Both runners take --settle-minutes; a queued cell defaults to 60 and a
 * trial to 20. A trial also takes --events <file>, which writes the session's
 * event stream: a record says what happened, a transcript says why.
 *
 * `status` is what may be consulted between runs. `analyse` is not: deciding
 * whether to continue after seeing the quality gap is repeated testing of
 * accumulating data. See DESIGN.md "Accumulation".
 *
 * `cell` exists because the first live cell has to be chosen rather than
 * drawn. Nothing in the agent-side path -- Pi in the container, the package
 * from a throwaway agent directory, `/swarm on`, the spend cap -- is proven
 * until one runs, and the queue would sell the dearest arm first. It writes no
 * record: a cell chosen by hand is not a measurement, and the analysis pairs
 * across arms on a fixed order it must not see hand-picked entries in.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyse } from "./analyse.mjs";
import { armModels, armNames } from "./arms.mjs";
import { runCell } from "./cell.mjs";
import {
  gradeableInstances,
  loadExclusions,
  loadInstances,
} from "./dataset.mjs";
import {
  assertProviderMatches,
  createManifest,
  pendingCells,
  statusReport,
} from "./queue.mjs";
import {
  appendRecord,
  readManifest,
  readRecords,
  writeManifest,
} from "./store.mjs";
import {
  assertModelsServed,
  prepareToolchain,
  providerEndpointHost,
  readAgentSettings,
} from "./toolchain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.BENCH_STORE ?? path.join(HERE, "store");
const AGENT_DIR =
  process.env.BENCH_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
const TOOLCHAIN = process.env.BENCH_TOOLCHAIN ?? path.join(HERE, ".toolchain");

/**
 * A path flag that a trial may write to, which is anywhere but the store.
 *
 * A hand-picked cell is not a sample from the drawn order, so nothing it
 * produces may land where the analysis reads.
 */
function outsideStore(name) {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (path.resolve(value).startsWith(path.resolve(STORE)))
    throw new Error(`--${name} must not write into the store`);
  // Checked now rather than discovered at the end. A failed write is swallowed
  // where it happens, because by then the cell has been paid for and losing
  // the measurement to report a bad path would be the worse trade -- but that
  // means a directory that does not exist costs the whole transcript in
  // silence, and the transcript is the reason the flag exists.
  const parent = path.dirname(path.resolve(value));
  if (!existsSync(parent))
    throw new Error(`--${name}: ${parent} does not exist`);
  return value;
}

/**
 * The one host a cell's container may reach, or undefined to leave it open.
 *
 * Confinement is the default because a cell runs an agent as root inside a
 * third-party image with real credentials copied in; see DESIGN.md "What a
 * cell exposes". `BENCH_EGRESS=open` turns it off, and says so in the record
 * of what was run rather than being inferred from a missing flag.
 *
 * A provider whose endpoint cannot be read from the catalogue is not guessed
 * at. Guessing wrong confines the cell away from the provider it needs, and
 * that failure looks exactly like a model declining the task.
 */
async function egressAllowHost(provider) {
  const mode = process.env.BENCH_EGRESS ?? "allowlist";
  if (mode === "open") {
    console.log("egress unconfined (BENCH_EGRESS=open)");
    return undefined;
  }
  if (mode !== "allowlist")
    throw new Error(`BENCH_EGRESS must be "allowlist" or "open", got: ${mode}`);
  const host =
    process.env.BENCH_EGRESS_ALLOW ??
    (await providerEndpointHost(AGENT_DIR, provider));
  if (host === undefined) {
    throw new Error(
      `cannot tell which host "${provider}" talks to, so the container ` +
        "cannot be confined to it. Name it in BENCH_EGRESS_ALLOW, or set " +
        "BENCH_EGRESS=open to run the cell with open egress deliberately.",
    );
  }
  console.log(`egress confined to ${host}`);
  return host;
}

/**
 * The per-cell spend ceiling, required rather than optional.
 *
 * `capUsd` undefined means no ceiling (`bench/cell.mjs`), and the package
 * under test has no budget of its own -- `docs/NEXT.md` defers that
 * deliberately, on the grounds that the operator watching a run is the
 * enforcement. That makes this flag the only ceiling there is, and a ceiling
 * you can remove by forgetting it is not one. A cell that needs no limit can
 * say so by naming a large number.
 */
function requireCap() {
  const raw = flag("cap");
  if (raw === undefined)
    throw new Error(
      "--cap <usd> is required: it is the only spend ceiling a cell has, " +
        "because the package under test has no budget of its own.",
    );
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap <= 0)
    throw new Error(`--cap must be a positive number of dollars, got: ${raw}`);
  return cap;
}

/**
 * How long a cell may run before it is called a timeout, in minutes.
 *
 * `runCell` defaults to an hour, which is the right ceiling for a queued cell
 * bought deliberately and the wrong one for a trial: a first live run that
 * hangs should say so in ten minutes, not occupy the box for an hour to reach
 * the same conclusion. Both commands take it; only the trial's default is
 * short.
 */
function settleMs(defaultMinutes) {
  const raw = flag("settle-minutes");
  const minutes = raw === undefined ? defaultMinutes : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error(`--settle-minutes must be a positive number, got: ${raw}`);
  return Math.round(minutes * 60_000);
}

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
  // Counted by id rather than by subtracting lengths: an exclusion or a record
  // for an instance outside the subset would otherwise cancel out a genuinely
  // unvalidated one and the pool would be drawn short without saying so.
  const accounted = new Set([
    ...gradeable.map((i) => i.id),
    ...dropped.map((d) => d.id),
  ]);
  const unvalidated = subset
    .map((row) => row.instance_id)
    .filter((id) => !accounted.has(id));
  if (unvalidated.length > 0 && !process.argv.includes("--partial-pool")) {
    throw new Error(
      `${unvalidated.length} of ${subset.length} instances are not validated ` +
        `yet: ${unvalidated.join(", ")}. The task order is drawn once and ` +
        "cannot be extended: finish validate-instances.py, or pass " +
        "--partial-pool to fix the order over the smaller pool deliberately.",
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
  // Split, because the two are different claims: one is a derivation that came
  // up empty, the other a decision someone took. A single total hides which.
  const excluded = await loadExclusions();
  console.log(
    `${manifest.order.length} tasks, seed ${seed}, ${dropped.length} dropped ` +
      `(${dropped.length - excluded.size} ungradeable, ${excluded.size} excluded)`,
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

/**
 * Everything a cell needs before a container is started, shared by `run` and
 * `cell` so the one-off trial is equipped exactly as a queued cell is.
 *
 * The provider is settled first and the toolchain installed second, because
 * `prepareToolchain` fetches from the registry on every call. A run that is
 * going to be refused for serving the wrong provider should be refused before
 * it spends a minute proving it can install Pi.
 */
async function prepareExecution({ manifest, arms = [] } = {}) {
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
  if (manifest !== undefined) assertProviderMatches(manifest, provider);
  const allowHost = await egressAllowHost(provider);
  // Before the image, not after: a model the provider does not serve fails at
  // `set_model`, which is minutes and ~14 GB of disk further in.
  for (const arm of arms)
    await assertModelsServed(AGENT_DIR, provider, armModels(arm));

  const toolchain = await prepareToolchain({
    dir: TOOLCHAIN,
    piSpec: flag("pi", "@earendil-works/pi-coding-agent@0.85.1"),
    packageSpec: flag("package-spec", "pi-worker-graph@latest"),
  });
  console.log(
    `pi ${toolchain.piVersion}, pi-worker-graph ${toolchain.packageVersion}`,
  );
  return { toolchain, provider, allowHost };
}

async function run(count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("run needs a positive cell count");
  const cap = requireCap();
  const manifest = await readManifest(STORE);
  const records = await readRecords(STORE);
  const { gradeable } = await gradeableInstances();
  const byId = new Map(gradeable.map((i) => [i.id, i]));
  const queue = pendingCells(manifest, records).slice(0, count);
  if (queue.length === 0) {
    console.log("nothing pending");
    return;
  }

  const { toolchain, allowHost } = await prepareExecution({
    manifest,
    arms: [...new Set(queue.map((c) => c.arm))],
  });
  if (toolchain.packageVersion !== undefined) {
    // The store says which package a cell measured, because a task re-run
    // under a different version is a different measurement.
    manifest.packageVersion = `pi-worker-graph@${toolchain.packageVersion}`;
  }

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
      settleMs: settleMs(60),
      egressAllowHost: allowHost,
    });
    await appendRecord(STORE, record);
    console.log(
      `  => ${record.class} (${record.outcome}) $${record.costUsd ?? "?"}`,
    );
  }
}

/**
 * One named cell, outside the queue.
 *
 * It refuses to write to the store. A hand-picked cell is not a sample from
 * the drawn order, and the analysis pairs across arms on that order; letting
 * one in would put a chosen task where a drawn one belongs. The record is
 * printed instead, and `--out` writes it somewhere that is not the store.
 */
async function trialCell(taskId, armName) {
  if (!taskId || !armName) {
    throw new Error(
      `usage: bench.mjs cell <instance-id> <arm>, arm one of ${armNames().join(", ")}`,
    );
  }
  if (!armNames().includes(armName)) {
    throw new Error(`unknown arm: ${armName}; one of ${armNames().join(", ")}`);
  }
  // Checked before anything is started, not after. Every refusal in this
  // function has to land before the first container, because past that point
  // the cell has already been paid for.
  const out = outsideStore("out");
  // A trial exists to be diagnosed, and the record alone cannot explain a
  // session that settled without spending anything. The queue does not carry
  // this: a stored run keeps records, not transcripts.
  const events = outsideStore("events");
  const capUsd = requireCap();

  const { gradeable } = await gradeableInstances();
  const instance = gradeable.find((i) => i.id === taskId);
  if (!instance) {
    throw new Error(
      `${taskId} is not a gradeable instance. ` +
        `Pick one of: ${gradeable.map((i) => i.id).join(", ")}`,
    );
  }

  // A trial is held to the store's provider when there is a store, so that a
  // path proven on one rate card is not then bought on another. Before `init`
  // there is nothing to check against and the printed line is the only record.
  const manifest = existsSync(path.join(STORE, "manifest.json"))
    ? await readManifest(STORE)
    : undefined;
  const { toolchain, provider, allowHost } = await prepareExecution({
    manifest,
    arms: [armName],
  });

  // Repetition 0 can never be a queue cell -- `enumerateCells` counts from 1 --
  // so even if this record were copied into the store by hand it could not
  // settle a drawn cell or be picked up as one.
  const cell = { task: taskId, arm: armName, repetition: 0 };
  console.log(`\n${taskId} ${armName} (trial, not recorded)`);
  const record = await runCell({
    instance,
    cell,
    // Not a stored manifest: a trial has no drawn order behind it. Only the
    // two version fields a record carries are needed, and they are the ones
    // that say what was actually exercised.
    manifest: {
      harnessVersion: await harnessVersion(),
      packageVersion:
        toolchain.packageVersion === undefined
          ? "pi-worker-graph@unknown"
          : `pi-worker-graph@${toolchain.packageVersion}`,
    },
    agentDirectorySource: AGENT_DIR,
    toolchainDir: toolchain.dir,
    packageTree: toolchain.packageTree,
    packageVersion: toolchain.packageVersion,
    provider,
    capUsd,
    settleMs: settleMs(20),
    egressAllowHost: allowHost,
    onEvents:
      events === undefined
        ? undefined
        : async (captured) => {
            await writeFile(events, `${JSON.stringify(captured, null, 2)}\n`);
            console.log(
              `${captured.events.length} events, ${captured.toolCalls.length} tool calls -> ${events}`,
            );
          },
  });

  if (out !== undefined)
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  console.log(
    `\n=> ${record.class} (${record.outcome}) $${record.costUsd ?? "?"}` +
      `${out === undefined ? "" : ` -> ${out}`}`,
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "init") return init();
  if (command === "status") return status();
  if (command === "run") return run(Number(process.argv[3]));
  if (command === "cell") return trialCell(process.argv[3], process.argv[4]);
  if (command === "analyse") {
    const manifest = await readManifest(STORE);
    console.log(
      JSON.stringify(analyse(manifest, await readRecords(STORE)), null, 2),
    );
    return;
  }
  console.log(
    "usage: bench.mjs init|status|run <count>|analyse|cell <instance-id> <arm>",
  );
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
