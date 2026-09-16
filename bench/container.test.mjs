import assert from "node:assert/strict";
import test from "node:test";

import { awaitHeadroom } from "./container.mjs";

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
