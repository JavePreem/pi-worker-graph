import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { gradeableInstances, loadExclusions } from "./dataset.mjs";

/**
 * A scratch directory holding the two cached dataset pages the loader reads,
 * so nothing here reaches the network.
 */
async function fixture({ records, exclusions }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-dataset-"));
  const row = (id) => ({ row: { instance_id: id, language: "TypeScript" } });
  await writeFile(
    path.join(dir, "full1.json"),
    JSON.stringify({ rows: [row("kept"), row("excluded")] }),
  );
  await writeFile(path.join(dir, "full2.json"), JSON.stringify({ rows: [] }));
  const resultsPath = path.join(dir, "validate-results.json");
  await writeFile(resultsPath, JSON.stringify(records));
  const exclusionsPath = path.join(dir, "excluded-instances.json");
  await writeFile(exclusionsPath, JSON.stringify(exclusions));
  return { scratch: dir, resultsPath, exclusionsPath };
}

test("an excluded instance is dropped with its reason, not graded", async () => {
  const options = await fixture({
    records: [
      { instance_id: "kept", fail_to_pass: ["//kept:test"] },
      { instance_id: "excluded", fail_to_pass: ["//excluded:test"] },
    ],
    exclusions: { excluded: "no Bazel test rules" },
  });
  const { gradeable, dropped } = await gradeableInstances(options);
  assert.deepEqual(
    gradeable.map((g) => g.id),
    ["kept"],
  );
  assert.deepEqual(dropped, [
    { id: "excluded", reason: "no Bazel test rules" },
  ]);
});

test("an exclusion holds even when a validation record says gradeable", async () => {
  // The order of the two files must not decide the pool: a record derived
  // before the decision was taken cannot put the instance back.
  const options = await fixture({
    records: [
      {
        instance_id: "excluded",
        fail_to_pass: ["//excluded:test"],
        before: { "//excluded:test": "fail" },
      },
    ],
    exclusions: { excluded: "kept out by decision" },
  });
  const { gradeable, dropped } = await gradeableInstances(options);
  assert.deepEqual(gradeable, []);
  assert.deepEqual(dropped, [
    { id: "excluded", reason: "kept out by decision" },
  ]);
});

test("a missing exclusions file excludes nothing", async () => {
  const options = await fixture({
    records: [{ instance_id: "kept", fail_to_pass: ["//kept:test"] }],
    exclusions: {},
  });
  const { gradeable } = await gradeableInstances({
    ...options,
    exclusionsPath: path.join(options.scratch, "absent.json"),
  });
  assert.deepEqual(
    gradeable.map((g) => g.id),
    ["kept"],
  );
  assert.deepEqual(
    [...(await loadExclusions({ exclusionsPath: "absent" }))],
    [],
  );
});

test("an exclusion naming no instance is refused, not counted as dropped", async () => {
  // The failure it guards: the instance stays gradeable, `dropped` still rises
  // by one, and every total an operator would check comes out as expected.
  const options = await fixture({
    records: [{ instance_id: "kept", fail_to_pass: ["//kept:test"] }],
    exclusions: { keptX: "a typo for kept" },
  });
  await assert.rejects(gradeableInstances(options), /absent from the dataset/);
});

test("an exclusion without a usable reason is refused", async () => {
  const options = await fixture({
    records: [{ instance_id: "kept", fail_to_pass: ["//kept:test"] }],
    exclusions: { excluded: "" },
  });
  await assert.rejects(gradeableInstances(options), /needs a reason/);
});

test("an exclusions file that is an array is refused", async () => {
  const options = await fixture({
    records: [{ instance_id: "kept", fail_to_pass: ["//kept:test"] }],
    exclusions: ["excluded"],
  });
  await assert.rejects(gradeableInstances(options), /id -> reason/);
});

test("the shipped exclusions name the three ant-design instances", async () => {
  const excluded = await loadExclusions();
  assert.deepEqual([...excluded.keys()].sort(), [
    "ant-design__ant-design-52470",
    "ant-design__ant-design-53739",
    "ant-design__ant-design-54813",
  ]);
  for (const reason of excluded.values()) assert.match(reason, /Bazel/);
});
