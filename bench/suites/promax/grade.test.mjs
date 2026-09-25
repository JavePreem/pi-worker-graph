import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { partitionValidated } from "./dataset.mjs";
import { classifyTargetRun, gradeTier1, patchPaths } from "./grade.mjs";
import { prepare } from "./suite.mjs";

/**
 * A container whose /testbed is a real git checkout on the host, so the
 * commit and the restore run for real. Bazel is the one thing faked: every
 * target passes.
 */
async function checkoutContainer(files) {
  const root = await mkdtemp(path.join(tmpdir(), "bench-grade-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "bench-grade-tmp-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(root, name), text);
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const local = (s) =>
    s
      .replace(/\/tmp\/(\w+\.diff)/g, `${scratch}/$1`)
      .replaceAll("/testbed", root);
  return {
    root,
    write: (file, text) => writeFile(local(file), text),
    exec: async (script) => {
      if (script.includes("bazelisk"))
        return { code: 0, stdout: "", stderr: "" };
      try {
        const stdout = execFileSync("bash", ["-c", local(script)], {
          stdio: "pipe",
        });
        return { code: 0, stdout: String(stdout), stderr: "" };
      } catch (error) {
        return { code: error.status, stdout: "", stderr: String(error.stderr) };
      }
    },
    cleanup: () =>
      Promise.all(
        [root, scratch].map((d) => rm(d, { recursive: true, force: true })),
      ),
  };
}

const HELPER_PATCH = `diff --git a/helper.ts b/helper.ts
--- a/helper.ts
+++ b/helper.ts
@@ -1 +1 @@
-call(a, false);
+call(a, null, false);
diff --git a/new_spec.ts b/new_spec.ts
new file mode 100644
--- /dev/null
+++ b/new_spec.ts
@@ -0,0 +1 @@
+it();
`;

test("the paths a patch touches, created files included", () => {
  assert.deepEqual(patchPaths(HELPER_PATCH), ["helper.ts", "new_spec.ts"]);
});

test("the tests are committed before the agent starts", async () => {
  const container = await checkoutContainer({
    "helper.ts": "call(a, false);\n",
  });
  try {
    await prepare(container, { testPatch: HELPER_PATCH });
    assert.equal(
      await readFile(path.join(container.root, "new_spec.ts"), "utf8"),
      "it();\n",
    );
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: container.root,
    });
    assert.equal(String(status), "");
  } finally {
    await container.cleanup();
  }
});

test("what the agent did to the tests is discarded before grading", async () => {
  const container = await checkoutContainer({
    "helper.ts": "call(a, false);\n",
  });
  try {
    await prepare(container, { testPatch: HELPER_PATCH });
    await writeFile(path.join(container.root, "helper.ts"), "call(a);\n");
    await writeFile(path.join(container.root, "new_spec.ts"), "it.skip();\n");
    const graded = await gradeTier1(container, {
      testPatch: HELPER_PATCH,
      targets: ["//a:test"],
    });
    assert.equal(graded.resolved, true);
    for (const [file, text] of [
      ["helper.ts", "call(a, null, false);\n"],
      ["new_spec.ts", "it();\n"],
    ]) {
      assert.equal(
        await readFile(path.join(container.root, file), "utf8"),
        text,
      );
    }
  } finally {
    await container.cleanup();
  }
});

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
