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

test("the pinned tests are the test files under the library's test paths", () => {
  const files = [
    "toolz/itertoolz.py",
    "toolz/tests/test_itertoolz.py",
    "toolz/tests/__init__.py",
    "toolz/sandbox/tests/test_core.py",
    "doc/test_notes.py",
  ];
  assert.deepEqual(_internal.testFiles(files, _internal.LIBRARIES.toolz), [
    "toolz/sandbox/tests/test_core.py",
    "toolz/tests/test_itertoolz.py",
  ]);
});

test("the prompt names every gutted function and the command that judges them", () => {
  const prompt = taskPrompt({
    library: "toolz",
    tests: ["toolz/tests/test_itertoolz.py"],
    functions: [{ path: "toolz/itertoolz.py", name: "partition_all" }],
  });
  assert.match(prompt, /python3 -m pytest toolz\/tests toolz\/sandbox\/tests/);
  assert.match(prompt, /toolz\/itertoolz\.py: partition_all/);
  assert.match(preamble, /restored to their original state/);
});
