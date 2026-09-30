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
 * checkout starts a fresh repository, so no history holds the originals.
 * Every file outside the package is restored before grading, and grading runs
 * only the pinned test files.
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
 * run in the task image with nothing but pytest, when the image does not
 * already carry an installed copy the agent could read the originals from
 * (more-itertools is out on that count), and when its code is hard enough
 * that `solo-luna` does not restore it (toolz is out on that count).
 *
 * `tests` are test directories, or single test files. `deselect` names tests
 * left out of the agent's command, the trace, and grading alike.
 */
const LIBRARIES = {
  chess: {
    repository: [
      "https://github.com/niklasf/python-chess",
      "0c6bdaccfcb3b09cdbe94b0f81e948cb2a356015",
    ],
    package: "chess",
    tests: ["test.py"],
    // Its UCI tests drive a mock engine through an event loop; a body that
    // raises inside the loop leaves the test awaiting a reply that never
    // comes, so a gutted checkout hangs instead of failing.
    deselect: ["test.py::EngineTestCase"],
  },
  parso: {
    repository: [
      "https://github.com/davidhalter/parso",
      "b26da16316da46e4770d589ed5f8d404531a22af",
    ],
    package: "parso",
    tests: ["test"],
    deselect: [],
  },
};

/** How many functions a task guts. Sized so `solo-luna` fails (criterion 1). */
export const COUNT = Number(process.env.BENCH_RESTORE_COUNT ?? 20);
if (!Number.isInteger(COUNT) || COUNT < 1) {
  throw new Error(
    `BENCH_RESTORE_COUNT must be a positive integer, got: ${process.env.BENCH_RESTORE_COUNT}`,
  );
}
const MODES = ["spread", "cluster"];
const SEED = 1;
/** Bodies shorter than this are left alone: each gut should be real work. */
const MIN_LINES = 15;

export const preamble = `You are working in a checkout at ${TESTBED} of an open-source Python library.
Python 3.11 with its standard library and pytest are available; nothing can
be installed.

Some of the library's functions have had their bodies removed: each now
raises NotImplementedError. Re-implement every one of them so that the
library's own test suite passes again. No other copy of the library exists
in the container or its history, and none can be downloaded.

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

/** Changes whenever the material would: this file builds it, the tool guts. */
async function buildKey() {
  return createHash("sha256")
    .update(revision)
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(TOOL))
    .digest("hex")
    .slice(0, 12);
}

/** The library's tracked files. */
async function trackedFiles(clone) {
  const listed = await sh(["git", "-C", clone, "ls-files"], "git ls-files");
  return listed.split("\n").filter((file) => file.length > 0);
}

/** The library's tests left out, as the options `restore.py` passes on. */
function deselected(library) {
  return LIBRARIES[library].deselect.map((id) => `--deselect=${id}`);
}

/**
 * The pinned test files: each listed test file, and every `test_*.py` under
 * the listed test directories.
 */
function testFiles(files, library) {
  return files
    .filter((file) =>
      library.tests.some(
        (entry) =>
          file === entry ||
          (file.startsWith(`${entry}/`) && /(^|\/)test_[^/]*\.py$/.test(file)),
      ),
    )
    .sort();
}

/**
 * What grading restores: every tracked file outside the package, so no edit
 * to a test, its data, or the pytest configuration changes the grade.
 */
function restoredFiles(files, library) {
  return files.filter((file) => !file.startsWith(`${library.package}/`));
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
        `/out/${path.basename(out)} ${[...deselected(library), ...tests].join(" ")}`,
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
  const files = await trackedFiles(clone);
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
  // Bytes, not text: a library carries binary data and files in other
  // encodings, which a round trip through UTF-8 would corrupt.
  const original = async (file) => readFile(path.join(clone, file));

  const staging = path.join(dir, "staging");
  await rm(staging, { recursive: true, force: true });
  const checkout = [];
  for (const file of files)
    checkout.push([file, built.files[file] ?? (await original(file))]);
  await writeTree(path.join(staging, "checkout"), checkout);
  await writeTree(
    path.join(staging, "tests"),
    await Promise.all(
      restoredFiles(files, config).map(async (file) => [
        file,
        await original(file),
      ]),
    ),
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

export function taskPrompt({ library, functions }) {
  const command = [...LIBRARIES[library].tests, ...deselected(library)];
  return [
    `The library is ${library}. Run its tests with:`,
    `  python3 -m pytest ${command.join(" ")}`,
    "",
    `The ${functions.length} functions to re-implement:`,
    ...functions.map(
      ({ path: file, name: qualname }) => `  ${file}: ${qualname}`,
    ),
    "",
    "Grading runs that command's tests, as they are now.",
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
        library,
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
    `cd ${GRADE} && timeout 1500 python3 restore.py grade ${TESTBED} ${GRADE}/result.json ${[...deselected(task.library), ...task.tests].join(" ")}`,
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
export const _internal = { LIBRARIES, testFiles, restoredFiles };
