// Tests for the Pi RPC client's framing and failure handling. Run with
// `node --test bench/`. These need no Pi process: the subprocess boundary is
// faked, the same way the package's adapter suite fakes it.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PiRpcClient } from "./rpc-client.mjs";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }

  /**
   * The real lifecycle: "exit" once the process ends, then "close" only after
   * its stdio streams have closed. A fake that emitted only "exit" would let a
   * client that resolves too early look correct.
   */
  finish(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit("exit", code, signal);
      setImmediate(() => this.emit("close", code, signal));
    });
  }
}

function client() {
  const child = new FakeChild();
  child.stdin.resume();
  return {
    child,
    rpc: new PiRpcClient({
      args: [],
      cwd: ".",
      env: {},
      spawnProcess: () => child,
    }),
  };
}

const line = (value) => `${JSON.stringify(value)}\n`;

test("a settlement arriving in the same chunk as its response is not lost", async () => {
  const { child, rpc } = client();
  const mark = rpc.settledMark;
  const sent = rpc.send({ type: "prompt", message: "go" });
  // Both records land in one chunk, so #drain dispatches the settlement before
  // the caller awaiting the response has resumed to register a wait.
  child.stdout.write(
    line({ type: "response", id: "c0", command: "prompt", success: true }) +
      line({ type: "agent_settled" }),
  );
  assert.equal((await sent).success, true);
  assert.equal(
    await rpc.waitSettled(50, mark),
    "settled",
    "a mark taken before the send must still see the settlement",
  );
});

test("sendAndSettle survives the same interleaving", async () => {
  const { child, rpc } = client();
  const pending = rpc.sendAndSettle(
    { type: "prompt", message: "go" },
    { settleMs: 50 },
  );
  child.stdout.write(
    line({ type: "response", id: "c0", command: "prompt", success: true }) +
      line({ type: "agent_settled" }),
  );
  assert.equal((await pending).outcome, "settled");
});

test("a process that dies mid-turn settles as failed, not as a completed turn", async () => {
  const { child, rpc } = client();
  const mark = rpc.settledMark;
  const waiting = rpc.waitSettled(5000, mark);
  child.emit("exit", 1, null);
  assert.equal(await waiting, "failed");
});

test("a waiter registered after a failure reports it immediately", async () => {
  const { child, rpc } = client();
  child.emit("exit", 1, null);
  assert.equal(await rpc.waitSettled(5000), "failed");
});

test("pending commands settle when the process dies", async () => {
  const { child, rpc } = client();
  const pending = rpc.send({ type: "get_state" }, 60_000);
  child.emit("exit", 1, null);
  const response = await pending;
  assert.equal(response.success, false);
  assert.match(response.error, /pi exited/u);
});

test("a spawn that never starts is reported rather than thrown", async () => {
  const { child, rpc } = client();
  const pending = rpc.send({ type: "get_state" }, 60_000);
  child.emit("error", new Error("spawn pi ENOENT"));
  assert.match((await pending).error, /could not be started/u);
});

test("a record split across chunks mid-character is decoded intact", async () => {
  const { child, rpc } = client();
  const record = line({ type: "custom", text: "héllo — 日本語 🎯" });
  const bytes = Buffer.from(record, "utf8");
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  await new Promise((resolve) => setImmediate(resolve));
  const seen = rpc.events.find((event) => event.type === "custom");
  assert.equal(seen?.text, "héllo — 日本語 🎯");
});

test("a final record without a trailing newline is not dropped", async () => {
  const { child, rpc } = client();
  child.stdout.write(JSON.stringify({ type: "custom", text: "last" }));
  child.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(rpc.events.some((event) => event.text === "last"));
});

// A process that never started, and one whose streams closed without an exit
// notification, both end without "exit". Waiting only on "exit" would sit out
// the whole fallback timeout for each.
for (const [name, end] of [
  [
    "the spawn never started",
    (child) => child.emit("error", new Error("spawn pi ENOENT")),
  ],
  [
    "the process closed without an exit event",
    (child) => child.emit("close", 1, null),
  ],
]) {
  test(`close returns promptly when ${name}`, async () => {
    const { child, rpc } = client();
    end(child);
    const started = Date.now();
    await rpc.close(true);
    assert.ok(
      Date.now() - started < 1000,
      `close took ${Date.now() - started}ms; it must not wait out the fallback`,
    );
  });
}

test("a clean close leaves no timer holding the event loop open", async () => {
  const { child, rpc } = client();
  queueMicrotask(() => child.finish(0));
  await rpc.close();
  // A pending 15s timeout would keep the process alive well past the test.
  const pending = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout");
  assert.equal(
    pending.length,
    0,
    `expected no lingering timers, found ${pending.length}`,
  );
});

test("close waits for the streams to drain, not just for the process to exit", async () => {
  const { child, rpc } = client();
  // Node emits "exit" while the stdio streams may still be open. A client that
  // resolved on "exit" would hand back an event list missing whatever the
  // child wrote last.
  queueMicrotask(() => {
    child.emit("exit", 0, null);
    // The buffered tail flushes on a later turn than "exit", as it does for a
    // real child, so a client that resolves on "exit" misses it.
    setImmediate(() => {
      child.stdout.write(line({ type: "custom", text: "written after exit" }));
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0, null));
    });
  });
  await rpc.close();
  assert.ok(
    rpc.events.some((event) => event.text === "written after exit"),
    "the final record must be drained before close() returns",
  );
});

test("the command defaults to pi and can be replaced to reach a container", () => {
  const spawned = [];
  const make = (options) => {
    const child = new FakeChild();
    child.stdin.resume();
    new PiRpcClient({
      args: ["--mode", "rpc"],
      cwd: ".",
      env: {},
      spawnProcess: (command, args) => {
        spawned.push([command, args]);
        return child;
      },
      ...options,
    });
  };
  make({});
  make({ command: "docker" });
  assert.equal(spawned[0][0], "pi");
  assert.equal(spawned[1][0], "docker");
  assert.deepEqual(spawned[0][1], ["--mode", "rpc"]);
});
