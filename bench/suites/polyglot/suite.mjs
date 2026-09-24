/**
 * The polyglot suite: Aider's polyglot benchmark (Exercism practice
 * exercises), bundled several to a task, graded by each exercise's hidden
 * tests.
 *
 * Frontier models come close to saturating these exercises one at a time,
 * and cheaper models fall well short, so a bundle can separate the two while
 * staying well short of ProMax's cost. A bundle is decomposable by
 * construction: its exercises share nothing, so a graph arm has a real
 * fan-out to make, and a cell whose parent does not make it is a finding
 * about the parent rather than about the task.
 *
 * The tests are hidden, as in Aider's first attempt: the checkout carries each
 * exercise's instructions and stub, and the test files arrive only at grade
 * time. The example solutions never enter the container except in the
 * self-test, where they stand in for the agent.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureImage as ensurePresent,
  run,
  TESTBED,
} from "../../container.mjs";
import { resolveTier1, runCommandTarget } from "../../grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(HERE, "image");

export const name = "polyglot";

const REPOSITORY = "https://github.com/Aider-AI/polyglot-benchmark";
const COMMIT = "7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f";

/**
 * Exercises per task. Three is the smallest bundle that gives a parent more
 * than a pair to split, and a bundle resolves only if every exercise does, so
 * a per-exercise pass rate p becomes p^3 per task: a larger bundle would push
 * the strong arm's resolve rate down faster than it separates the arms.
 */
export const BUNDLE_SIZE = 3;

export const revision = `${REPOSITORY}@${COMMIT} bundles of ${BUNDLE_SIZE}`;

const SCRATCH = process.env.BENCH_SCRATCH ?? "/tmp/pi-worker-graph-bench";
const CHECKOUT = path.join(SCRATCH, "polyglot-benchmark");

/**
 * How each language is run. The test commands are Aider's, so a result here
 * means what it means there: `xtest(` is un-skipped in the JavaScript specs
 * and nothing else is, which leaves the two upstream `test.skip` cases that
 * time out most implementations skipped.
 */
const LANGUAGES = {
  python: {
    about: "Python 3.11, standard library only. Tests run with pytest.",
    // No conftest.py and no ini file the agent may have left: either can skip
    // or deselect every test, and pytest then exits 0 over code that is wrong.
    command: (tests) =>
      "python3 -m pytest -q -p no:cacheprovider --noconftest -c /dev/null " +
      `--rootdir . ${tests.join(" ")}`,
    tests: (text) => text,
  },
  javascript: {
    about:
      "JavaScript on Node.js 22, no packages beyond what is installed. " +
      "Tests run with Jest (/node_modules/.bin/jest).",
    command: (tests) =>
      // By path: a bare argument is a regex over every test path, so a spec
      // the agent left in a subdirectory under the same name would run too.
      // An explicit empty config, so a jest.config.js the agent left cannot
      // ignore the specs and pass with none run.
      "/node_modules/.bin/jest --ci --watchman=false --config {} " +
      `--runTestsByPath ${tests.join(" ")}`,
    tests: (text) => text.replace(/\bxtest\(/g, "test("),
  },
};

export const preamble = `You are working in a checkout at ${TESTBED}. It holds several independent
programming exercises, one directory each.

For each exercise:
- Its instructions are in its .docs/ directory. Read all of them.
- Implement it in the exercise's existing solution file. Keep the names of the
  existing functions, classes and exports: the tests import them.

How the work is judged:
- After you finish, each exercise's hidden tests are added to its directory
  and run. The task is solved only if every exercise passes all of its tests.
- You may write and run checks of your own, but a hidden test file overwrites
  any file of the same name.
- Do not change package.json, babel.config.js or other configuration: the
  tests run under it as it is.

The task follows.

`;

/** The pinned exercise checkout, cloned into the scratch directory once. */
async function checkout() {
  if (!existsSync(path.join(CHECKOUT, ".git"))) {
    const cloned = await run(["git", "clone", "-q", REPOSITORY, CHECKOUT], {
      timeoutMs: 600_000,
    });
    if (cloned.code !== 0)
      throw new Error(`git clone ${REPOSITORY}: ${cloned.stderr.slice(-400)}`);
  }
  const head = await run(["git", "-C", CHECKOUT, "rev-parse", "HEAD"]);
  if (head.stdout.trim() !== COMMIT) {
    const moved = await run([
      "git",
      "-C",
      CHECKOUT,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "-q",
      COMMIT,
    ]);
    if (moved.code !== 0)
      throw new Error(
        `${CHECKOUT} cannot check out ${COMMIT}: ${moved.stderr.slice(-400)}`,
      );
  }
  return CHECKOUT;
}

async function exercise(language, root, exerciseName) {
  const dir = path.join(root, language, "exercises", "practice", exerciseName);
  const { files } = JSON.parse(
    await readFile(path.join(dir, ".meta", "config.json"), "utf8"),
  );
  return {
    name: exerciseName,
    dir,
    solution: files.solution,
    test: files.test,
    example: files.example,
  };
}

/** Consecutive runs of `size`, the remainder folded into the last. */
export function bundle(items, size) {
  const groups = [];
  for (let i = 0; i + size <= items.length; i += size)
    groups.push(items.slice(i, i + size));
  const rest = items.length % size;
  if (rest > 0) {
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(...items.slice(items.length - rest));
  }
  return groups;
}

export function taskPrompt(language, exercises) {
  const lines = exercises.map(
    (e) => `- ${TESTBED}/${e.name}: implement ${e.solution.join(", ")}`,
  );
  return `${LANGUAGES[language].about}\n\nExercises:\n${lines.join("\n")}\n`;
}

/**
 * Every bundle, in a fixed order. Bundling is alphabetical within a language,
 * which is arbitrary with respect to difficulty; the task id names the
 * exercises, so the composition is recorded wherever the id is.
 */
export async function loadTasks({ root } = {}) {
  const source = root ?? (await checkout());
  const image = await imageTag();
  const tasks = [];
  for (const language of Object.keys(LANGUAGES)) {
    const practice = path.join(source, language, "exercises", "practice");
    const names = (await readdir(practice, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const exercises = await Promise.all(
      names.map((n) => exercise(language, source, n)),
    );
    for (const group of bundle(exercises, BUNDLE_SIZE)) {
      tasks.push({
        id: `${language}/${group.map((e) => e.name).join("+")}`,
        image,
        language,
        prompt: taskPrompt(language, group),
        exercises: group,
      });
    }
  }
  return { tasks, dropped: [] };
}

/** Files of an exercise the agent may see: not `.meta/`, and not the tests. */
async function visibleFiles(ex, dir = ex.dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (relative === ".meta" || ex.test.includes(relative)) continue;
    if (entry.isDirectory())
      out.push(
        ...(await visibleFiles(ex, path.join(dir, entry.name), relative)),
      );
    else out.push(relative);
  }
  return out.sort();
}

async function writeInto(container, ex, relative, contents) {
  const target = path.posix.join(TESTBED, ex.name, relative);
  const made = await container.exec(
    `mkdir -p ${JSON.stringify(path.posix.dirname(target))}`,
  );
  if (made.code !== 0) throw new Error(`mkdir for ${target}: ${made.stderr}`);
  await container.write(target, contents);
}

/**
 * The checkout: each exercise's visible files under `TESTBED/<name>`, and a
 * baseline commit so the cell's diff is exactly the agent's work.
 *
 * Written through the container rather than copied in, so every file is owned
 * by the container's root. A `docker cp` keeps the host UID, and with every
 * capability dropped root cannot write a file it does not own -- the agent
 * would be unable to edit its own stubs.
 */
export async function prepare(container, task) {
  const files = [];
  for (const ex of task.exercises) {
    for (const relative of await visibleFiles(ex)) {
      files.push([
        path.posix.join(TESTBED, ex.name, relative),
        path.join(ex.dir, relative),
      ]);
    }
  }
  // Every directory in one exec rather than one per file.
  const dirs = [
    ...new Set(files.map(([target]) => path.posix.dirname(target))),
  ];
  const made = await container.exec(
    `mkdir -p ${dirs.map((d) => JSON.stringify(d)).join(" ")}`,
  );
  if (made.code !== 0) throw new Error(`mkdir: ${made.stderr.slice(-400)}`);
  for (const [target, source] of files)
    await container.write(target, await readFile(source, "utf8"));
  const committed = await container.exec(
    `cd ${TESTBED} && git init -q && git add -A && ` +
      "git -c user.name=bench -c user.email=bench@invalid commit -qm baseline",
  );
  if (committed.code !== 0)
    throw new Error(`baseline commit: ${committed.stderr.slice(-400)}`);
}

/**
 * Each exercise is one target: its pristine tests written over whatever is at
 * their paths, then run by file name so a test file the agent added cannot
 * fail or pass the grade.
 *
 * Every other file the checkout started with is restored too, except the
 * solution: package.json and babel.config.js decide how the tests run, and
 * the agent was told not to change them rather than prevented.
 */
export async function grade(container, task) {
  const language = LANGUAGES[task.language];
  const states = {};
  for (const ex of task.exercises) {
    for (const relative of await visibleFiles(ex)) {
      if (ex.solution.includes(relative)) continue;
      const text = await readFile(path.join(ex.dir, relative), "utf8");
      await writeInto(container, ex, relative, text);
    }
    for (const relative of ex.test) {
      const text = await readFile(path.join(ex.dir, relative), "utf8");
      await writeInto(container, ex, relative, language.tests(text));
    }
    states[ex.name] = await runCommandTarget(
      container,
      `bash -c ${JSON.stringify(`cd ${TESTBED}/${ex.name} && ${language.command(ex.test)}`)}`,
    );
  }
  return {
    ...resolveTier1({ targets: task.exercises.map((e) => e.name), states }),
    states,
  };
}

/** The example solutions, standing in for the agent in the self-test. */
export async function applyReference(container, task) {
  for (const ex of task.exercises) {
    if (ex.example.length !== ex.solution.length) {
      return {
        applied: false,
        detail: `${ex.name}: ${ex.example.length} examples for ${ex.solution.length} solution files`,
      };
    }
    for (const [i, example] of ex.example.entries()) {
      await writeInto(
        container,
        ex,
        ex.solution[i],
        await readFile(path.join(ex.dir, example), "utf8"),
      );
    }
  }
  return { applied: true };
}

/** The image tag, named by a hash of everything that builds it. */
export async function imageTag() {
  const hash = createHash("sha256");
  for (const file of ["Dockerfile", "package.json", "package-lock.json"])
    hash.update(await readFile(path.join(IMAGE_DIR, file)));
  return `pi-bench-polyglot:${hash.digest("hex").slice(0, 12)}`;
}

/** Built on the host rather than pulled: there is no registry copy. */
export function ensureImage(image) {
  return ensurePresent(image, async () => {
    const built = await run(["docker", "build", "-q", "-t", image, IMAGE_DIR], {
      timeoutMs: 1_800_000,
    });
    if (built.code !== 0)
      throw new Error(`docker build ${image}: ${built.stderr.slice(-400)}`);
  });
}
