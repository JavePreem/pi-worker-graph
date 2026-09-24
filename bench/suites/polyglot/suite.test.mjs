import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyReference, bundle, grade, loadTasks, prepare } from "./suite.mjs";

/** A practice tree shaped like the pinned checkout, with no network. */
async function fixture(exercises) {
  const root = await mkdtemp(path.join(tmpdir(), "bench-polyglot-"));
  for (const [language, name] of exercises) {
    const dir = path.join(root, language, "exercises", "practice", name);
    const stem = name.replaceAll("-", "_");
    const [solution, spec] =
      language === "python"
        ? [`${stem}.py`, `${stem}_test.py`]
        : [`${name}.js`, `${name}.spec.js`];
    await mkdir(path.join(dir, ".meta"), { recursive: true });
    await mkdir(path.join(dir, ".docs"), { recursive: true });
    await writeFile(
      path.join(dir, ".meta", "config.json"),
      JSON.stringify({
        files: { solution: [solution], test: [spec], example: [".meta/ex"] },
      }),
    );
    await writeFile(path.join(dir, ".meta", "ex"), "the answer");
    await writeFile(path.join(dir, ".docs", "instructions.md"), "do it");
    await writeFile(path.join(dir, solution), "stub");
    await writeFile(path.join(dir, spec), "xtest('a', f); xit('b', f);");
  }
  for (const language of ["python", "javascript"])
    await mkdir(path.join(root, language, "exercises", "practice"), {
      recursive: true,
    });
  return root;
}

/** A container that records what was written and what was run. */
function fakeContainer({ testExit = 0 } = {}) {
  const files = new Map();
  const scripts = [];
  return {
    files,
    scripts,
    write: async (p, contents) => files.set(p, contents),
    exec: async (script) => {
      scripts.push(script);
      const code = script.startsWith("timeout ") ? testExit : 0;
      return { code, stdout: "", stderr: "" };
    },
  };
}

test("a bundle folds the remainder into the last group", () => {
  assert.deepEqual(bundle([1, 2, 3, 4, 5, 6, 7], 3), [
    [1, 2, 3],
    [4, 5, 6, 7],
  ]);
  assert.deepEqual(bundle([1, 2], 3), [[1, 2]]);
});

test("a task id names every exercise in its bundle", async () => {
  const root = await fixture([
    ["python", "b-ex"],
    ["python", "a-ex"],
    ["python", "c-ex"],
    ["javascript", "d-ex"],
  ]);
  const { tasks } = await loadTasks({ root });
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["python/a-ex+b-ex+c-ex", "javascript/d-ex"],
  );
  assert.match(tasks[0].prompt, /\/testbed\/a-ex: implement a_ex\.py/);
});

test("the checkout carries the tests the grade runs, but not the example", async () => {
  const root = await fixture([["javascript", "d-ex"]]);
  const [task] = (await loadTasks({ root })).tasks;
  const container = fakeContainer();
  await prepare(container, task);
  assert.deepEqual([...container.files.keys()].sort(), [
    "/testbed/d-ex/.docs/instructions.md",
    "/testbed/d-ex/d-ex.js",
    "/testbed/d-ex/d-ex.spec.js",
  ]);
  // Un-skipped as graded, so a passing local run means a passing grade.
  assert.equal(
    container.files.get("/testbed/d-ex/d-ex.spec.js"),
    "test('a', f); xit('b', f);",
  );
  assert.match(container.scripts.at(-1), /git init -q && git add -A/);
});

test("an edited test is overwritten before it is run", async () => {
  const root = await fixture([["python", "a-ex"]]);
  const [task] = (await loadTasks({ root })).tasks;
  const container = fakeContainer();
  container.files.set("/testbed/a-ex/a_ex_test.py", "assert True");
  await grade(container, task);
  assert.equal(
    container.files.get("/testbed/a-ex/a_ex_test.py"),
    "xtest('a', f); xit('b', f);",
  );
});

test("grading writes the pristine tests and runs them by name", async () => {
  const root = await fixture([["javascript", "d-ex"]]);
  const [task] = (await loadTasks({ root })).tasks;
  const container = fakeContainer();
  const graded = await grade(container, task);
  assert.equal(graded.resolved, true);
  // Aider's harness un-skips `xtest(` and nothing else.
  assert.equal(
    container.files.get("/testbed/d-ex/d-ex.spec.js"),
    "test('a', f); xit('b', f);",
  );
  assert.match(
    container.scripts.at(-1),
    /jest --ci --watchman=false --config \{\} --runTestsByPath d-ex\.spec\.js/,
  );
});

test("grading restores what the checkout started with, except the solution", async () => {
  const root = await fixture([["python", "a-ex"]]);
  const [task] = (await loadTasks({ root })).tasks;
  const container = fakeContainer();
  container.files.set("/testbed/a-ex/a_ex.py", "the agent's work");
  container.files.set("/testbed/a-ex/.docs/instructions.md", "edited");
  await grade(container, task);
  assert.equal(
    container.files.get("/testbed/a-ex/a_ex.py"),
    "the agent's work",
  );
  assert.equal(
    container.files.get("/testbed/a-ex/.docs/instructions.md"),
    "do it",
  );
  // A conftest.py or ini file the agent left must not decide the run.
  assert.match(container.scripts.at(-1), /--noconftest -c \/dev\/null/);
});

test("a bundle with one failing exercise is unresolved", async () => {
  const root = await fixture([
    ["python", "a-ex"],
    ["python", "b-ex"],
  ]);
  const [task] = (await loadTasks({ root })).tasks;
  const graded = await grade(fakeContainer({ testExit: 1 }), task);
  assert.equal(graded.resolved, false);
  assert.deepEqual(graded.failed, ["a-ex", "b-ex"]);
});

test("the reference solution lands on the solution file", async () => {
  const root = await fixture([["python", "a-ex"]]);
  const [task] = (await loadTasks({ root })).tasks;
  const container = fakeContainer();
  assert.deepEqual(await applyReference(container, task), { applied: true });
  assert.equal(container.files.get("/testbed/a-ex/a_ex.py"), "the answer");
});
