import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitHeadroom,
  conflictedFiles,
  startContainer,
} from "./container.mjs";

test("headroom the host already has is not waited for", async () => {
  let waited = false;
  await awaitHeadroom({ minFreeKb: 0, onWait: () => (waited = true) });
  assert.equal(waited, false);
});

test("headroom that never arrives is reported and then proceeded past", async () => {
  // Better a pull that might be killed than a sweep that stops silently: the
  // wait exists to avoid the kill, not to become one.
  const seen = [];
  await awaitHeadroom({
    minFreeKb: Number.MAX_SAFE_INTEGER,
    waitMs: 0,
    pollMs: 1,
    onWait: (_kb, giveUp) => seen.push(giveUp),
  });
  assert.deepEqual(seen, [true]);
});

test("a host that keeps the memory busy is polled until the deadline", async () => {
  const seen = [];
  await awaitHeadroom({
    minFreeKb: Number.MAX_SAFE_INTEGER,
    waitMs: 30,
    pollMs: 1,
    onWait: (_kb, giveUp) => seen.push(giveUp),
  });
  assert.ok(seen.length > 1, "polled more than once");
  assert.equal(seen.at(-1), true);
  assert.equal(
    seen.slice(0, -1).every((giveUp) => giveUp === false),
    true,
  );
});

test("the image's inherited proxy is cleared, or nothing can reach a provider", async () => {
  // The ProMax images carry their builder's internal proxy. Left in place it
  // fails every outbound request from inside the container, and the agent
  // settles having spent nothing -- indistinguishable, in the record, from a
  // model that simply did not do the work.
  let argv;
  await startContainer("img", {
    name: "c",
    exec: async (args) => {
      argv = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const joined = argv.join(" ");
  for (const name of ["http_proxy", "https_proxy", "HTTPS_PROXY", "no_proxy"]) {
    assert.ok(joined.includes(`-e ${name}=`), `${name} not cleared`);
  }
});

test("a container gives up the privileges a compile-and-test workload never needs", async () => {
  // The image is third-party and the cell runs an agent in it as root with
  // real credentials copied in. This is the blast radius, not the window.
  let argv;
  await startContainer("img", {
    name: "c",
    exec: async (args) => {
      argv = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const joined = argv.join(" ");
  assert.ok(joined.includes("--security-opt no-new-privileges"));
  assert.ok(joined.includes("--cap-drop ALL"));
  assert.ok(joined.includes("--pids-limit"));
});

test("every file git apply refused is named once", () => {
  const stderr = [
    "error: patch failed: packages/compiler/test/a_spec.ts:8",
    "error: packages/compiler/test/a_spec.ts: patch does not apply",
    "error: patch failed: packages/compiler/test/b_spec.ts:2203",
    "error: packages/compiler/test/b_spec.ts: patch does not apply",
  ].join("\n");
  assert.deepEqual(conflictedFiles(stderr), [
    "packages/compiler/test/a_spec.ts",
    "packages/compiler/test/b_spec.ts",
  ]);
});

test("output that names no refused file yields no files", () => {
  assert.deepEqual(conflictedFiles("error: cannot read /tmp/x.diff"), []);
  assert.deepEqual(conflictedFiles(), []);
});
