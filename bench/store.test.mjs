import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createManifest, makeRecord } from "./queue.mjs";
import {
  appendRecord,
  readManifest,
  readRecords,
  storePaths,
  writeManifest,
} from "./store.mjs";

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-store-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const manifest = () =>
  createManifest({
    taskIds: ["t1", "t2"],
    seed: 3,
    harnessVersion: "h",
    packageVersion: "p",
  });

test("a manifest round-trips", async () => {
  await withStore(async (dir) => {
    const written = manifest();
    await writeManifest(dir, written);
    assert.deepEqual(await readManifest(dir), written);
  });
});

test("a second manifest is refused, because the order is fixed once", async () => {
  await withStore(async (dir) => {
    await writeManifest(dir, manifest());
    await assert.rejects(() => writeManifest(dir, manifest()), /fixed once/);
  });
});

test("reading a store with no manifest says to init rather than returning nothing", async () => {
  await withStore(async (dir) => {
    await assert.rejects(() => readManifest(dir), /run "init" first/);
  });
});

test("records append and read back in order", async () => {
  await withStore(async (dir) => {
    const m = manifest();
    assert.deepEqual(await readRecords(dir), []);
    for (const task of m.order) {
      await appendRecord(
        dir,
        makeRecord({
          cell: { task, arm: "solo-sol", repetition: 1 },
          cellClass: "resolved",
          outcome: "resolved",
          manifest: m,
        }),
      );
    }
    const records = await readRecords(dir);
    assert.deepEqual(
      records.map((r) => r.cell.task),
      m.order,
    );
  });
});

test("a truncated trailing line names itself rather than being guessed at", async () => {
  await withStore(async (dir) => {
    const m = manifest();
    await appendRecord(
      dir,
      makeRecord({
        cell: { task: "t1", arm: "solo-sol", repetition: 1 },
        cellClass: "resolved",
        outcome: "resolved",
        manifest: m,
      }),
    );
    const { cells } = storePaths(dir);
    const text = await readRecords(dir);
    assert.equal(text.length, 1);
    await writeFile(cells, `${JSON.stringify(text[0])}\n{"cell":`, {
      flag: "w",
    });
    await assert.rejects(
      () => readRecords(dir),
      /cells\.jsonl:2 is not a record/,
    );
  });
});
