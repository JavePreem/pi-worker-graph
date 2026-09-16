/**
 * The store on disk: one manifest, one append-only cell log.
 *
 * Analysis reads the whole log. Nothing reads "the last run", and nothing
 * rewrites a record -- a cell that has settled is a measurement, and a store
 * that can be edited after the fact is a store whose order was chosen for its
 * answer.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function storePaths(dir) {
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    cells: path.join(dir, "cells.jsonl"),
  };
}

/**
 * Written once. A second call is refused rather than merged: the permutation
 * is what makes separate runs one experiment, and redrawing it after results
 * exist would silently restart the experiment under the same file name.
 */
export async function writeManifest(dir, manifest) {
  const paths = storePaths(dir);
  if (existsSync(paths.manifest)) {
    throw new Error(
      `a manifest already exists at ${paths.manifest}; the order is fixed once`,
    );
  }
  await mkdir(dir, { recursive: true });
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  return paths;
}

export async function readManifest(dir) {
  const paths = storePaths(dir);
  if (!existsSync(paths.manifest)) {
    throw new Error(`no manifest at ${paths.manifest}; run "init" first`);
  }
  return JSON.parse(await readFile(paths.manifest, "utf8"));
}

/** Every record ever written, in the order it was written. */
export async function readRecords(dir) {
  const paths = storePaths(dir);
  if (!existsSync(paths.cells)) return [];
  const text = await readFile(paths.cells, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        // A truncated last line is the shape a kill leaves. Say which line, so
        // it can be dropped deliberately rather than by a parser guessing.
        throw new Error(
          `${paths.cells}:${index + 1} is not a record: ${error.message}`,
        );
      }
    });
}

/**
 * One line, appended once the cell has settled and been graded. Append is the
 * whole durability story: a crash before this leaves no half-record, so the
 * cell is simply pending again.
 */
export async function appendRecord(dir, record) {
  const paths = storePaths(dir);
  await mkdir(dir, { recursive: true });
  await appendFile(paths.cells, `${JSON.stringify(record)}\n`);
}
