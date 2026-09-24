import assert from "node:assert/strict";
import test from "node:test";

import { resolveTier1, runCommandTarget } from "./grade.mjs";

test("resolved needs every fail-to-pass target", () => {
  const states = {
    "//a:test": { state: "pass" },
    "//b:test": { state: "fail" },
  };
  const verdict = resolveTier1({ targets: ["//a:test", "//b:test"], states });
  assert.equal(verdict.resolved, false);
  assert.equal(verdict.outcome, "unresolved");
  assert.deepEqual(verdict.failed, ["//b:test"]);
});

test("a regression is reported apart from an unresolved instance", () => {
  const states = {
    "//a:test": { state: "pass" },
    "//kept:test": { state: "fail" },
  };
  const verdict = resolveTier1({
    targets: ["//a:test"],
    regressionTargets: ["//kept:test"],
    states,
  });
  assert.equal(verdict.resolved, false);
  assert.equal(verdict.outcome, "regressed");
  assert.deepEqual(verdict.regressed, ["//kept:test"]);
});

test("an ungraded target is a harness outcome, never a resolve", () => {
  const verdict = resolveTier1({ targets: ["//a:test"], states: {} });
  assert.equal(verdict.resolved, false);
  assert.equal(verdict.outcome, "harness");
});

test("all targets passing resolves", () => {
  const verdict = resolveTier1({
    targets: ["//a:test"],
    regressionTargets: ["//kept:test"],
    states: { "//a:test": { state: "pass" }, "//kept:test": { state: "pass" } },
  });
  assert.deepEqual(verdict, { resolved: true, outcome: "resolved" });
});

const exitsWith = (result) => ({
  exec: async () => ({ stdout: "", stderr: "", timedOut: false, ...result }),
});

test("a command target passes only on exit 0", async () => {
  assert.equal(
    (await runCommandTarget(exitsWith({ code: 0 }), "t")).state,
    "pass",
  );
  const failed = await runCommandTarget(exitsWith({ code: 1 }), "t");
  assert.equal(failed.state, "fail");
  assert.equal(failed.reason, "exit 1");
});

test("a command stopped by its own timeout fails as a timeout", async () => {
  // `timeout` exits 124; read as an ordinary nonzero exit, a solution that
  // loops forever would be indistinguishable from one that is wrong.
  const run = await runCommandTarget(exitsWith({ code: 124 }), "t");
  assert.equal(run.state, "fail");
  assert.equal(run.reason, "timeout");
});

test("a command target is bounded inside the container", async () => {
  const scripts = [];
  await runCommandTarget(
    {
      exec: async (script) => {
        scripts.push(script);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    "pytest x_test.py",
    { timeoutS: 7 },
  );
  assert.deepEqual(scripts, ["timeout 7 pytest x_test.py"]);
});
