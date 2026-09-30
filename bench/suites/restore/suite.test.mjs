import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _internal, preamble, taskPrompt } from "./suite.mjs";

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "python",
  "restore.py",
);

const body = (name, calls = "") =>
  `def ${name}(x):\n    """Doc of ${name}."""\n    y = x\n    y = y + 1\n    y = y * 2\n    ${calls || "y = y - 1"}\n    return y\n`;

/**
 * A package of two modules: `a` with three linked functions and a short one,
 * `b` with two functions, one of which runs at import time.
 */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-restore-"));
  await mkdir(path.join(dir, "pkg"), { recursive: true });
  await writeFile(path.join(dir, "pkg", "__init__.py"), "");
  await writeFile(
    path.join(dir, "pkg", "a.py"),
    [
      body("one", "y = two(y)"),
      body("two", "y = three(y)"),
      body("three"),
      "def short(x):\n    return x\n",
    ].join("\n"),
  );
  await writeFile(
    path.join(dir, "pkg", "b.py"),
    [body("four"), body("setup"), "SETUP = setup(1)\n"].join("\n"),
  );
  const firstLines = async (file) => {
    const text = await readFile(path.join(dir, file), "utf8");
    return Object.fromEntries(
      text
        .split("\n")
        .map((line, index) => [line, index + 1])
        .filter(([line]) => line.startsWith("def "))
        .map(([line, number]) => [line.slice(4, line.indexOf("(")), number]),
    );
  };
  const a = await firstLines("pkg/a.py");
  const b = await firstLines("pkg/b.py");
  const trace = {
    covered: {
      "pkg/a.py": [a.one, a.two, a.three, a.short],
      "pkg/b.py": [b.four, b.setup],
    },
    import: { "pkg/b.py": [b.setup] },
  };
  await writeFile(path.join(dir, "trace.json"), JSON.stringify(trace));
  return dir;
}

function build(dir, mode, count) {
  const out = path.join(dir, `${mode}-${count}.json`);
  execFileSync("python3", [
    TOOL,
    "build",
    dir,
    "pkg",
    path.join(dir, "trace.json"),
    out,
    mode,
    String(count),
    "1",
    "5",
  ]);
  return readFile(out, "utf8").then(JSON.parse);
}

test("only functions the tests call, importing does not, and worth re-writing are candidates", async () => {
  const dir = await fixture();
  const built = await build(dir, "spread", 2);
  // one, two, three and four: `short` is a one-liner, `setup` runs at import.
  assert.equal(built.candidates, 4);
  const names = built.functions.map((f) => f.name);
  assert.equal(names.includes("short"), false);
  assert.equal(names.includes("setup"), false);
});

test("spread takes from every module before a second from any", async () => {
  const built = await build(await fixture(), "spread", 2);
  assert.deepEqual(built.functions.map((f) => f.path).sort(), [
    "pkg/a.py",
    "pkg/b.py",
  ]);
});

test("cluster stays in one module and grows along its calls", async () => {
  const built = await build(await fixture(), "cluster", 3);
  assert.deepEqual(
    built.functions.map((f) => f.path),
    ["pkg/a.py", "pkg/a.py", "pkg/a.py"],
  );
  assert.deepEqual(built.functions.map((f) => f.name).sort(), [
    "one",
    "three",
    "two",
  ]);
});

test("a gutted body raises, keeps its docstring, and the module still compiles", async () => {
  const dir = await fixture();
  const built = await build(dir, "cluster", 3);
  const gutted = built.files["pkg/a.py"];
  assert.match(
    gutted,
    /def two\(x\):\n {4}"""Doc of two\."""\n {4}raise NotImplementedError\n/,
  );
  assert.match(gutted, /def short\(x\):\n {4}return x/);
  const file = path.join(dir, "gutted.py");
  await writeFile(file, gutted);
  execFileSync("python3", ["-m", "py_compile", file]);
});

const hasPytest = (() => {
  try {
    execFileSync("python3", ["-c", "import pytest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Grading runs in the task image, which has pytest; a host may not.
test("a test that never returns fails on its own and the rest still grade", {
  skip: !hasPytest && "no pytest on this host",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-restore-"));
  await writeFile(
    path.join(dir, "test_wait.py"),
    "import time\n\ndef test_waits():\n    time.sleep(3600)\n\ndef test_passes():\n    assert True\n",
  );
  const out = path.join(dir, "result.json");
  execFileSync("python3", [TOOL, "grade", dir, out, "test_wait.py"], {
    env: { ...process.env, RESTORE_TEST_TIMEOUT_S: "1" },
    timeout: 60_000,
  });
  const { groups } = JSON.parse(await readFile(out, "utf8"));
  assert.equal(groups["test_wait.py"].passed, 1);
  assert.equal(groups["test_wait.py"].total, 2);
  assert.match(
    groups["test_wait.py"].failures[0],
    /^test_waits: .*ran over 1 s/,
  );
});

test("the pinned tests are the listed test files and the test files under the listed directories", () => {
  const files = [
    "chess/__init__.py",
    "test.py",
    "test/test_parser.py",
    "test/normalizer_issue_files/E10.py",
    "docs/test_notes.py",
  ];
  const library = { tests: ["test.py", "test"] };
  assert.deepEqual(_internal.testFiles(files, library), [
    "test.py",
    "test/test_parser.py",
  ]);
});

test("grading restores every tracked file outside the package", () => {
  const files = [
    "parso/grammar.py",
    "conftest.py",
    "pytest.ini",
    "test/data.py",
  ];
  assert.deepEqual(_internal.restoredFiles(files, _internal.LIBRARIES.parso), [
    "conftest.py",
    "pytest.ini",
    "test/data.py",
  ]);
});

test("the prompt names every gutted function and the command that judges them", () => {
  const prompt = taskPrompt({
    library: "parso",
    tests: ["test/test_parser.py"],
    functions: [{ path: "parso/python/diff.py", name: "DiffParser.update" }],
  });
  assert.match(prompt, /python3 -m pytest test\n/);
  assert.match(prompt, /parso\/python\/diff\.py: DiffParser\.update/);
  const chess = taskPrompt({
    library: "chess",
    tests: ["test.py"],
    functions: [],
  });
  assert.match(
    chess,
    /python3 -m pytest test\.py --deselect=test\.py::EngineTestCase\n/,
  );
  assert.match(preamble, /restored to their original state/);
  assert.match(preamble, /No other copy of the library exists/);
});
