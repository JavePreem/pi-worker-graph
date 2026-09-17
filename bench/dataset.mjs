/**
 * The instance set the bench draws from, and the recorded facts about it.
 *
 * Three files back this. The dataset pages are ProMax as served, cached under
 * the scratch directory. `validate-results.json` is ours: the fail-to-pass
 * target set for each instance, which the dataset does not ship and
 * `validate-instances.py` derived by running the gold patch. A cell reads the
 * recorded set rather than deriving one, so grading at trial time is a test
 * run and nothing else.
 *
 * `excluded-instances.json` is the third, and it is deliberately not the
 * second: it holds instances kept out of the pool by a design decision rather
 * than by a derivation that was run and came up empty. Mixing the two would
 * put an unmeasured claim in the file whose whole warrant is that every row in
 * it was measured. Both scripts read it, so the pool is defined once.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SCRATCH =
  process.env.BENCH_SCRATCH ?? "/tmp/pi-worker-graph-bench";
export const DEFAULT_RESULTS =
  process.env.BENCH_RESULTS ?? path.join(HERE, "validate-results.json");
export const DEFAULT_EXCLUSIONS = path.join(HERE, "excluded-instances.json");

// The rows API caps a page at 100; 170 instances is two pages.
const ROWS_URL =
  "https://datasets-server.huggingface.co/rows" +
  "?dataset=swe-bench-promax/SWE-Bench-ProMax&config=default&split=test&offset=";

async function page(scratch, index) {
  const file = path.join(scratch, `full${index + 1}.json`);
  if (!existsSync(file)) {
    await mkdir(scratch, { recursive: true });
    const response = await fetch(`${ROWS_URL}${index * 100}&length=100`);
    if (!response.ok) {
      throw new Error(`dataset page ${index + 1}: HTTP ${response.status}`);
    }
    await writeFile(file, await response.text());
  }
  return JSON.parse(await readFile(file, "utf8")).rows;
}

/**
 * Instances kept out of the pool by decision, id -> reason.
 *
 * Removing an entry is how the decision is revisited: the validation sweep
 * will then pick the instance up again on its next run.
 *
 * The shape is checked rather than trusted. An array parses happily into
 * index-keyed entries, and a non-string reason prints as `[object Object]`
 * beside an instance nobody can then account for.
 */
export async function loadExclusions({
  exclusionsPath = DEFAULT_EXCLUSIONS,
} = {}) {
  if (!existsSync(exclusionsPath)) return new Map();
  const parsed = JSON.parse(await readFile(exclusionsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${exclusionsPath}: expected an object of id -> reason`);
  }
  for (const [id, reason] of Object.entries(parsed)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `${exclusionsPath}: ${id} needs a reason, as a non-empty string`,
      );
    }
  }
  return new Map(Object.entries(parsed));
}

/** Every instance in the dataset, keyed by id. */
export async function loadInstances({ scratch = DEFAULT_SCRATCH } = {}) {
  const rows = [...(await page(scratch, 0)), ...(await page(scratch, 1))];
  return new Map(rows.map((r) => [r.row.instance_id, r.row]));
}

/**
 * Split the validation records into what can be graded and what cannot, with
 * the reason. An instance with no fail-to-pass target cannot be scored at all
 * -- resolving it and failing it look identical -- so it is dropped before the
 * queue is enumerated rather than counted as a loss later.
 */
export function partitionValidated(records) {
  const gradeable = [];
  const dropped = [];
  for (const record of records) {
    const targets = record.fail_to_pass ?? [];
    if (targets.length === 0) {
      dropped.push({
        id: record.instance_id,
        reason: record.outcome ?? "no fail-to-pass target",
      });
      continue;
    }
    if (record.regressed?.length) {
      dropped.push({
        id: record.instance_id,
        reason: "gold patch regressed a target",
      });
      continue;
    }
    gradeable.push({
      id: record.instance_id,
      targets,
      // Targets the derivation found already passing before the gold patch.
      // They are the regression set: narrow, because it only covers rules the
      // test patch touched, which is what the derivation can see.
      regressionTargets: Object.entries(record.before ?? {})
        .filter(([, state]) => state === "pass")
        .map(([target]) => target),
    });
  }
  return { gradeable, dropped };
}

/** The gradeable instances, each joined to its dataset row. */
export async function gradeableInstances({
  scratch = DEFAULT_SCRATCH,
  resultsPath = DEFAULT_RESULTS,
  exclusionsPath = DEFAULT_EXCLUSIONS,
} = {}) {
  const records = JSON.parse(await readFile(resultsPath, "utf8"));
  const { gradeable: validated, dropped } = partitionValidated(records);
  const excluded = await loadExclusions({ exclusionsPath });
  const instances = await loadInstances({ scratch });

  // An exclusion that names nothing is the one failure this file can have that
  // looks like success: the instance stays in the pool, the dropped count
  // still rises, and the totals an operator checks come out exactly as
  // expected. The task order is drawn once, so by the time it surfaces the
  // store has to be thrown away. Refuse instead.
  const unknown = [...excluded.keys()].filter((id) => !instances.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `${exclusionsPath} names ${unknown.length} instance(s) absent from the ` +
        `dataset: ${unknown.join(", ")}. An exclusion that matches no ` +
        "instance would leave it in the pool while still counting as dropped.",
    );
  }

  // An excluded instance is dropped whether or not a record exists for it, so
  // a stale record cannot quietly put one back in the pool.
  const gradeable = validated.filter((entry) => !excluded.has(entry.id));
  for (const [id, reason] of excluded) dropped.push({ id, reason });
  return {
    dropped,
    gradeable: gradeable.map((entry) => {
      const row = instances.get(entry.id);
      if (!row)
        throw new Error(
          `validated instance absent from the dataset: ${entry.id}`,
        );
      return { ...entry, row };
    }),
  };
}
