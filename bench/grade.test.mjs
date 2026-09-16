import assert from "node:assert/strict";
import test from "node:test";

import { partitionValidated } from "./dataset.mjs";
import { classifyTargetRun, resolveTier1 } from "./grade.mjs";

test("a target that ran no test is not a pass", () => {
  // Bazel exits 4 when the pattern matched no test rule. Reading that as
  // success is how a grading harness inflates a resolve rate silently.
  assert.deepEqual(classifyTargetRun({ code: 4 }).state, "fail");
  assert.equal(classifyTargetRun({ code: 4 }).reason, "no test ran");
});

test("a build failure is a failure, not a harness fault", () => {
  const run = classifyTargetRun({ code: 1 });
  assert.equal(run.state, "fail");
  assert.equal(run.reason, "build failed");
});

test("a timeout fails the target whatever the exit code says", () => {
  assert.equal(classifyTargetRun({ code: 0, timedOut: true }).state, "fail");
});

test("the executed-test count is kept for the record", () => {
  const run = classifyTargetRun({
    code: 0,
    stdout: "Executed 12 out of 12 tests: ok",
  });
  assert.equal(run.state, "pass");
  assert.equal(run.executed, "Executed 12 out of 12 test");
});

test("an unknown exit code fails rather than passing by default", () => {
  assert.equal(classifyTargetRun({ code: 36 }).state, "fail");
});

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

test("an instance with no fail-to-pass target is dropped, not scored", () => {
  const { gradeable, dropped } = partitionValidated([
    {
      instance_id: "a",
      fail_to_pass: ["//a:test"],
      before: { "//a:test": "fail" },
    },
    { instance_id: "b", fail_to_pass: [], outcome: "NO FAIL-TO-PASS TARGET" },
  ]);
  assert.deepEqual(
    gradeable.map((g) => g.id),
    ["a"],
  );
  assert.deepEqual(dropped, [{ id: "b", reason: "NO FAIL-TO-PASS TARGET" }]);
});

test("a target already passing before the gold patch becomes the regression set", () => {
  const { gradeable } = partitionValidated([
    {
      instance_id: "a",
      fail_to_pass: ["//a:test"],
      before: { "//a:test": "fail", "//kept:test": "pass" },
    },
  ]);
  assert.deepEqual(gradeable[0].regressionTargets, ["//kept:test"]);
});

test("an instance whose gold patch regressed a target is dropped", () => {
  const { dropped } = partitionValidated([
    {
      instance_id: "a",
      fail_to_pass: ["//a:test"],
      regressed: ["//kept:test"],
    },
  ]);
  assert.equal(dropped[0].reason, "gold patch regressed a target");
});
