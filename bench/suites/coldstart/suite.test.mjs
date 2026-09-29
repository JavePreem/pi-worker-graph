import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { preamble, targetStates, taskPrompt } from "./suite.mjs";

const PYTHON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "python",
);

/** Runs runner.py over `cases` against a one-file implementation. */
async function runHidden(task, moduleSource, cases, extra = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-coldstart-"));
  await writeFile(path.join(dir, `${task}.py`), moduleSource);
  const casesPath = path.join(dir, "cases.json");
  await writeFile(casesPath, JSON.stringify(cases));
  const out = path.join(dir, "out.json");
  execFileSync("python3", [
    path.join(PYTHON, "runner.py"),
    task,
    dir,
    casesPath,
    out,
    ...extra,
  ]);
  return { ...JSON.parse(await readFile(out, "utf8")), casesPath };
}

test("a spec area is a passing target only when every one of its cases passes", () => {
  const states = targetStates({
    basic: { passed: 3, total: 3, failures: [] },
    slice: { passed: 1, total: 2, failures: ["slice 0: got null"] },
  });
  assert.equal(states.basic.state, "pass");
  assert.equal(states.slice.state, "fail");
  assert.equal(states.slice.reason, "1/2 passed");
  assert.match(states.slice.tail, /slice 0/);
});

test("every task names its contract module, and the preamble asks for tests", () => {
  assert.match(taskPrompt("mustache"), /mustache\.render\(/);
  assert.match(taskPrompt("jmespath"), /jmespath\.search\(/);
  assert.match(taskPrompt("jsonpath"), /jsonpath\.query\(/);
  assert.match(preamble, /python3 -m pytest tests/);
  assert.match(preamble, /only the public contract/);
});

test("every failing hidden case is kept, not a sample of them", async () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({
    group: "g",
    name: `c${i}`,
    expression: "a",
    given: {},
    result: i,
  }));
  const { groups } = await runHidden(
    "jmespath",
    "class JMESPathError(Exception): pass\ndef search(e, d): return None\n",
    cases,
  );
  assert.equal(groups.g.failures.length, 12);
  const states = targetStates(groups);
  assert.match(states.g.tail, /^c0: /);
  assert.match(states.g.tail, /\nc11: /);
});

test("a hidden case never takes a boolean for a number", async () => {
  const { groups } = await runHidden(
    "jmespath",
    "class JMESPathError(Exception): pass\ndef search(e, d): return True\n",
    [
      { group: "g", name: "one", expression: "a", given: {}, result: 1 },
      { group: "g", name: "true", expression: "a", given: {}, result: true },
    ],
  );
  assert.equal(groups.g.passed, 1);
  assert.match(groups.g.failures[0], /^one: got true/);
});

test("a hidden error case passes only on the exception the contract names", async () => {
  const { groups } = await runHidden(
    "jsonpath",
    "class JSONPathSyntaxError(Exception): pass\n" +
      "def query(q, d):\n    if q == '$[': raise JSONPathSyntaxError()\n" +
      "    raise ValueError()\n",
    [
      {
        group: "g",
        name: "named",
        selector: "$[",
        document: null,
        invalid_selector: true,
      },
      {
        group: "g",
        name: "other",
        selector: "$x",
        document: null,
        invalid_selector: true,
      },
    ],
  );
  assert.equal(groups.g.passed, 1);
  assert.match(groups.g.failures[0], /^other: .*raised ValueError/);
});

test("a runaway case fails alone, and consumed cases leave the disk", async () => {
  const { groups, casesPath } = await runHidden(
    "mustache",
    "def render(t, d, p=None):\n    while t == 'loop': pass\n    return t\n",
    [
      { group: "g", name: "loop", template: "loop", data: {}, expected: "" },
      { group: "g", name: "echo", template: "x", data: {}, expected: "x" },
    ],
    ["--consume"],
  );
  assert.equal(groups.g.passed, 1);
  assert.match(groups.g.failures[0], /^loop: timed out/);
  assert.equal(existsSync(casesPath), false);
});

test("an implementation that will not import fails every case", async () => {
  const { groups } = await runHidden(
    "mustache",
    "raise ImportError('nope')\n",
    [{ group: "g", name: "a", template: "x", data: {}, expected: "x" }],
  );
  assert.equal(groups.g.passed, 0);
  assert.match(groups.g.failures[0], /import mustache/);
});
