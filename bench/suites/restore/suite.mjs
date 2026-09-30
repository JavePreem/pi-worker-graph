/**
 * The restore suite: re-implement functions gutted out of a real library.
 *
 * Each task is a pinned open-source Python library with some functions'
 * bodies replaced by `raise NotImplementedError`, and its own test suite left
 * in place. The tests are the acceptance, as in real work where a command
 * already judges the change -- which is where the graph measured a saving on
 * the polyglot bundles (`bench/DESIGN.md` **What the bench says so far**).
 * Unlike those bundles, the pieces here share modules, imports, and each
 * other, so the suite can vary how coupled the work is:
 *
 * - `spread` guts functions across the package's modules, round-robin;
 * - `cluster` guts them inside one module, along its internal calls.
 *
 * Only functions the tests call are gutted, and never one that importing the
 * package calls: that would break every import, and no test could run. The
 * checkout starts a fresh repository, so no history holds the originals. The
 * tests are restored before grading, and grading runs only the pinned files.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run, TESTBED } from "../../container.mjs";
import { resolveTier1 } from "../../grade.mjs";
import { targetStates } from "../coldstart/suite.mjs";
import { ensureImage, imageTag } from "../polyglot/suite.mjs";

export { ensureImage };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = path.join(HERE, "python");
const TOOL = path.join(PYTHON, "restore.py");

export const name = "restore";

const SCRATCH = process.env.BENCH_SCRATCH ?? "/tmp/pi-worker-graph-bench";
const SOURCES = path.join(SCRATCH, "restore");

/**
 * Every library a task draws on, pinned. A library qualifies when its tests
 * run in the task image with nothing but pytest, and when the image does not
 * already carry an installed copy the agent could read the originals from
 * (more-itertools is out on that count).
 */
const LIBRARIES = {
  toolz: {
    repository: [
      "https://github.com/pytoolz/toolz",
      "451af60dec590a6010e2babdbf391ea8f815122f",
    ],
    package: "toolz",
    tests: ["toolz/tests", "toolz/sandbox/tests"],
    // Reads the installed distribution's metadata, which a checkout has not.
    exclude: ["toolz/tests/test_package.py"],
  },
};

/** How many functions a task guts. Sized so `solo-luna` fails (criterion 1). */
export const COUNT = Number(process.env.BENCH_RESTORE_COUNT ?? 12);
if (!Number.isInteger(COUNT) || COUNT < 1) {
  throw new Error(
    `BENCH_RESTORE_COUNT must be a positive integer, got: ${process.env.BENCH_RESTORE_COUNT}`,
  );
}
const MODES = ["spread", "cluster"];
const SEED = 1;
/** Bodies shorter than this are left alone: a one-liner tests nothing. */
const MIN_LINES = 5;

export const preamble = `You are working in a checkout at ${TESTBED} of an open-source Python library.
Python 3.11 with its standard library and pytest are available; nothing can
be installed.

Some of the library's functions have had their bodies removed: each now
raises NotImplementedError. Re-implement every one of them so that the
library's own test suite passes again.

The tests are the acceptance. They are restored to their original state
before grading, so changing them changes nothing. Run them from ${TESTBED}
with the command the task gives.

The task follows.

`;

/** What fixes the task text and its grading, for the fingerprint. */
export const revision = `restore ${Object.values(LIBRARIES)
  .map(({ repository: [, commit] }) => commit.slice(0, 12))
  .join(" ")} n${COUNT} s${SEED} l${MIN_LINES}`;

async function sh(args, what, options) {
  const result = await run(args, options);
  if (result.code !== 0)
    throw new Error(`${what}: ${(result.stderr || result.stdout).slice(-600)}`);
  return result.stdout;
}

async function fetchSources(root) {
  await mkdir(root, { recursive: true });
  for (const [library, { repository }] of Object.entries(LIBRARIES)) {
    const [url, commit] = repository;
    const target = path.join(root, library);
    if (!existsSync(path.join(target, ".git"))) {
      await sh(["git", "clone", "-q", url, target], `git clone ${url}`, {
        timeoutMs: 600_000,
      });
    }
    const head = (
      await sh(["git", "-C", target, "rev-parse", "HEAD"], library)
    ).trim();
    if (head !== commit) {
      await sh(
        [
          "git",
          "-C",
          target,
          "-c",
          "advice.detachedHead=false",
          "checkout",
          "-q",
          commit,
        ],
        `${library} cannot check out ${commit}`,
      );
    }
  }
}

async function buildKey() {
  return createHash("sha256")
    .update(revision)
    .update(await readFile(TOOL))
    .digest("hex")
    .slice(0, 12);
}

/** The library's tracked files, less the excluded ones. */
async function trackedFiles(clone, exclude) {
  const listed = await sh(["git", "-C", clone, "ls-files"], "git ls-files");
  return listed
    .split("\n")
    .filter((file) => file.length > 0 && !exclude.includes(file));
}

/** The pinned test files: every `test_*.py` under the library's test paths. */
function testFiles(files, library) {
  return files
    .filter(
      (file) =>
        library.tests.some((dir) => file.startsWith(`${dir}/`)) &&
        /(^|\/)test_[^/]*\.py$/.test(file),
    )
    .sort();
}

async function writeTree(dir, entries) {
  for (const [file, text] of entries) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

async function pack(dir, archive) {
  await sh(["tar", "-czf", archive, "-C", dir, "."], `pack ${archive}`);
}

/**
 * Records, once per library and build key, which functions the tests call and
 * which importing the package calls. It runs in the task image, so what
 * counts as covered is decided by the Python that grades.
 */
async function traceLibrary(root, library, key, image, tests) {
  const out = path.join(root, "build", `${library}-${key}-trace.json`);
  if (existsSync(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  await ensureImage(image);
  const clone = path.join(root, library);
  await sh(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/tmp",
      "-v",
      `${clone}:/src:ro`,
      "-v",
      `${PYTHON}:/tool:ro`,
      "-v",
      `${path.dirname(out)}:/out`,
      image,
      "bash",
      "-c",
      `cp -r /src /tmp/checkout && rm -rf /tmp/checkout/.git && ` +
        `python3 /tool/restore.py trace /tmp/checkout ${LIBRARIES[library].package} ` +
        `/out/${path.basename(out)} ${tests.join(" ")}`,
    ],
    `${library} trace`,
    { timeoutMs: 900_000 },
  );
  return out;
}

/**
 * Builds one task's material on the host, once per build key: the gutted
 * checkout, the pristine tests grading restores, and the original bodies the
 * self-test puts back.
 */
async function buildTask(root, id, library, mode, key, image) {
  const dir = path.join(root, "build", `${id}-${key}`);
  const done = path.join(dir, "task.json");
  if (existsSync(done)) return { dir, ...JSON.parse(await readFile(done)) };
  const config = LIBRARIES[library];
  const clone = path.join(root, library);
  const files = await trackedFiles(clone, config.exclude);
  const tests = testFiles(files, config);
  const traced = await traceLibrary(root, library, key, image, tests);
  const gutted = path.join(dir, "gutted.json");
  await mkdir(dir, { recursive: true });
  await sh(
    [
      "python3",
      TOOL,
      "build",
      clone,
      config.package,
      traced,
      gutted,
      mode,
      String(COUNT),
      String(SEED),
      String(MIN_LINES),
    ],
    `${id} build`,
  );
  const built = JSON.parse(await readFile(gutted, "utf8"));
  const original = async (file) => readFile(path.join(clone, file), "utf8");

  const staging = path.join(dir, "staging");
  await rm(staging, { recursive: true, force: true });
  const checkout = [];
  for (const file of files)
    checkout.push([file, built.files[file] ?? (await original(file))]);
  await writeTree(path.join(staging, "checkout"), checkout);
  await writeTree(
    path.join(staging, "tests"),
    await Promise.all(tests.map(async (file) => [file, await original(file)])),
  );
  await writeTree(
    path.join(staging, "reference"),
    await Promise.all(
      Object.keys(built.files).map(async (file) => [
        file,
        await original(file),
      ]),
    ),
  );
  for (const part of ["checkout", "tests", "reference"])
    await pack(path.join(staging, part), path.join(dir, `${part}.tgz`));
  await rm(staging, { recursive: true, force: true });

  const task = {
    library,
    mode,
    tests,
    functions: built.functions,
    candidates: built.candidates,
  };
  await writeFile(done, `${JSON.stringify(task, null, 2)}\n`);
  return { dir, ...task };
}

export function taskPrompt({ library, tests, functions }) {
  const directories = LIBRARIES[library].tests;
  return [
    `The library is ${library}. Run its tests with:`,
    `  python3 -m pytest ${directories.join(" ")}`,
    "",
    `The ${functions.length} functions to re-implement:`,
    ...functions.map(
      ({ path: file, name: qualname }) => `  ${file}: ${qualname}`,
    ),
    "",
    `Grading runs those tests, all ${tests.length} files of them, as they are now.`,
    "",
  ].join("\n");
}

export async function loadTasks({ root = SOURCES } = {}) {
  await fetchSources(root);
  const key = await buildKey();
  const image = await imageTag();
  const tasks = [];
  for (const library of Object.keys(LIBRARIES)) {
    for (const mode of MODES) {
      const id = `${library}-${mode}-${COUNT}`;
      const built = await buildTask(root, id, library, mode, key, image);
      tasks.push({
        id,
        image,
        prompt: taskPrompt(built),
        build: built.dir,
        tests: built.tests,
        functions: built.functions,
      });
    }
  }
  return { tasks, dropped: [] };
}

/**
 * Unpacks one of a task's archives into the container. The archive crosses as
 * base64 text through `container.write`, so the container's root owns what it
 * unpacks: with every capability dropped, root cannot write over files a
 * `docker cp` left owned by the host user.
 */
async function unpack(container, archive, target) {
  const staged = `/tmp/${path.basename(archive)}.b64`;
  await container.write(staged, (await readFile(archive)).toString("base64"));
  const result = await container.exec(
    `mkdir -p ${target} && base64 -d ${staged} | tar --no-same-owner -xzf - -C ${target} && rm -f ${staged}`,
    { timeoutMs: 300_000 },
  );
  if (result.code !== 0)
    throw new Error(`unpack ${archive}: ${result.stderr.slice(-400)}`);
}

/** The gutted checkout, in a fresh repository with one baseline commit. */
export async function prepare(container, task) {
  await unpack(container, path.join(task.build, "checkout.tgz"), TESTBED);
  const committed = await container.exec(
    `cd ${TESTBED} && git init -q && git add -A && ` +
      "git -c user.name=bench -c user.email=bench@invalid commit -qm baseline",
  );
  if (committed.code !== 0)
    throw new Error(`baseline commit: ${committed.stderr.slice(-400)}`);
}

const GRADE = "/grade";

async function readJson(container, file) {
  const read = await container.exec(`cat ${JSON.stringify(file)}`);
  if (read.code !== 0) return undefined;
  try {
    return JSON.parse(read.stdout);
  } catch {
    return undefined;
  }
}

/** Every pinned test file is one target; resolved means every test passes. */
export async function grade(container, task) {
  await unpack(container, path.join(task.build, "tests.tgz"), TESTBED);
  await container.exec(`mkdir -p ${GRADE}`);
  await container.write(`${GRADE}/restore.py`, await readFile(TOOL, "utf8"));
  const ran = await container.exec(
    `cd ${GRADE} && timeout 1500 python3 restore.py grade ${TESTBED} ${GRADE}/result.json ${task.tests.join(" ")}`,
    { timeoutMs: 1_600_000 },
  );
  const result = await readJson(container, `${GRADE}/result.json`);
  if (result === undefined) {
    return {
      resolved: false,
      outcome: "harness",
      detail: `the test suite did not report: ${(ran.stderr || ran.stdout).slice(-400)}`,
      states: {},
    };
  }
  const states = targetStates(result.groups);
  return { ...resolveTier1({ targets: task.tests, states }), states };
}

/** The original bodies, standing in for the agent in the self-test. */
export async function applyReference(container, task) {
  await unpack(container, path.join(task.build, "reference.tgz"), TESTBED);
  return { applied: true };
}

/** For the tests: the library table and what a task is built from. */
export const _internal = { LIBRARIES, testFiles };
