/**
 * The instance set the bench draws from, and the recorded facts about it.
 *
 * Two files back this. The dataset pages are ProMax as served, cached under
 * the scratch directory. `validate-results.json` is ours: the fail-to-pass
 * target set for each instance, which the dataset does not ship and
 * `validate-instances.py` derived by running the gold patch. A cell reads the
 * recorded set rather than deriving one, so grading at trial time is a test
 * run and nothing else.
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
} = {}) {
  const records = JSON.parse(await readFile(resultsPath, "utf8"));
  const { gradeable, dropped } = partitionValidated(records);
  const instances = await loadInstances({ scratch });
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
