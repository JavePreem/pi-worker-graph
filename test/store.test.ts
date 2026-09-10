import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import type { NodeOutput, RunStoreErrorCode } from "../src/index.js";
import {
  acquireRunOwnership,
  createRun,
  deleteRun,
  listRetainedRuns,
  normalizeGraph,
  publishNodeOutput,
  publishRunEvent,
  RUN_COORDINATION_MAX_ITEM_BYTES,
  RUN_COORDINATION_MAX_ITEMS,
  RUN_COORDINATION_MAX_PAGE_BYTES,
  RUN_COORDINATION_MAX_RECORD_BYTES,
  RUN_COORDINATION_MAX_RECORDS,
  RUN_COORDINATION_MAX_TEXT_BYTES,
  RUN_STORE_MAX_RECORD_BYTES,
  RunStoreError,
  readNodeOutput,
  readNodeState,
  readRun,
  readRunEvents,
  readRunMessages,
  releaseRunOwnership,
  sendRunMessage,
  writeNodeState,
} from "../src/index.js";
import { nodeOutput } from "./fixtures.js";

async function temporaryStateRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-graph-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function ownedRun(
  t: test.TestContext,
  root: string,
  graph: Parameters<typeof normalizeGraph>[0],
) {
  const manifest = await createRun(root, normalizeGraph(graph));
  const ownership = await acquireRunOwnership(root, manifest.runId);
  t.after(() => releaseRunOwnership(root, ownership));
  return { manifest, ownership };
}

async function rejectsWithCode(
  action: () => Promise<unknown>,
  code: RunStoreErrorCode,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RunStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test("creates and reopens a versioned run with initial node states", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({
    tasks: [
      { id: " first ", payload: { assignment: "implement" } },
      { id: "second", needs: [" first "] },
    ],
    concurrency: 2,
  });

  const created = await createRun(root, graph);
  const reopened = await readRun(root, created.runId);

  assert.deepEqual(reopened, created);
  assert.equal(reopened.schemaVersion, 1);
  assert.equal(reopened.kind, "run-manifest");
  assert.equal(reopened.graph.concurrency, 2);
  assert.deepEqual(
    reopened.graph.tasks.map((task) => ({
      id: task.id,
      needs: task.needs,
      payload: task.payload,
    })),
    [
      { id: "first", needs: [], payload: { assignment: "implement" } },
      { id: "second", needs: ["first"], payload: undefined },
    ],
  );
  assert.equal(
    (await readNodeState(root, created.runId, "first")).status,
    "pending",
  );
  assert.equal(
    (await readNodeState(root, created.runId, "second")).status,
    "pending",
  );
});

test("serializes ownership of one run and releases only its owner", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );

  const owner = await acquireRunOwnership(root, manifest.runId);
  assert.equal(owner.runId, manifest.runId);
  assert.match(owner.ownerId, /^[0-9a-f-]{36}$/);
  await rejectsWithCode(
    () => acquireRunOwnership(root, manifest.runId),
    "ownership",
  );
  await rejectsWithCode(
    () =>
      writeNodeState(root, manifest.runId, "task", "running", {
        runId: manifest.runId,
        ownerId: "8a2b0f2c-2c1d-4d1e-9a3f-6b5c4d3e2f10",
      }),
    "ownership",
  );
  await rejectsWithCode(
    () =>
      releaseRunOwnership(root, {
        runId: manifest.runId,
        ownerId: "8a2b0f2c-2c1d-4d1e-9a3f-6b5c4d3e2f10",
      }),
    "ownership",
  );
  await rejectsWithCode(
    () => acquireRunOwnership(root, manifest.runId),
    "ownership",
  );

  for (const capability of [
    undefined,
    null,
    {},
    { runId: manifest.runId },
    { runId: manifest.runId, ownerId: null },
  ]) {
    await rejectsWithCode(
      () => releaseRunOwnership(root, capability as never),
      "ownership",
    );
  }
  const hostileCapability = Object.create(null);
  Object.defineProperties(hostileCapability, {
    runId: {
      enumerable: true,
      get() {
        throw new RunStoreError("not_found", "must be normalized");
      },
    },
    ownerId: { enumerable: true, value: owner.ownerId },
  });
  await rejectsWithCode(
    () => releaseRunOwnership(root, hostileCapability as never),
    "ownership",
  );
  await rejectsWithCode(
    () =>
      writeNodeState(
        root,
        manifest.runId,
        "task",
        "running",
        undefined as never,
      ),
    "ownership",
  );

  // A mutation in flight is contention, reported apart from an ownership
  // conflict so that a waiting orchestrator does not read it as one.
  const mutationLock = join(root, "runs", manifest.runId, "mutation.lock");
  await writeFile(
    mutationLock,
    JSON.stringify({
      schemaVersion: 1,
      kind: "run-mutation-lock",
      runId: manifest.runId,
      taskId: "task",
    }),
  );
  await rejectsWithCode(() => releaseRunOwnership(root, owner), "locked");
  await rejectsWithCode(
    () => acquireRunOwnership(root, manifest.runId),
    "locked",
  );
  await rm(mutationLock);

  await releaseRunOwnership(root, owner);
  const replacement = await acquireRunOwnership(root, manifest.runId);
  await releaseRunOwnership(root, replacement);
  await rm(join(root, "runs", manifest.runId), {
    recursive: true,
    force: true,
  });
  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "task", "running", replacement),
    "not_found",
  );
});

test("publishes and queries coordination events and messages in order", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, {
    tasks: [{ id: "sender" }, { id: "recipient" }],
  });

  const first = await publishRunEvent(root, manifest.runId, {
    taskId: "sender",
    eventKind: "decision",
    message: "Use the shared interface.",
    paths: ["src/api.ts"],
    recipients: ["recipient"],
  });
  const second = await publishRunEvent(root, manifest.runId, {
    taskId: "recipient",
    eventKind: "risk",
    message: "The provider is unavailable.",
    symbols: ["createClient"],
  });
  const handoff = await sendRunMessage(root, manifest.runId, {
    senderTaskId: "sender",
    recipientTaskId: "recipient",
    message: "Please consume the shared interface.",
  });

  // One run-global sequence orders every coordination record, so a cursor
  // names a position that no later record can precede.
  assert.deepEqual(
    [first.eventId, second.eventId, handoff.messageId],
    ["000001", "000002", "000003"],
  );

  const page = await readRunEvents(root, manifest.runId, { limit: 1 });
  assert.deepEqual(
    page.events.map((event) => event.eventId),
    [first.eventId],
  );
  assert.equal(page.nextCursor, first.eventId);

  // A record published after the page was read must still be delivered.
  const third = await publishRunEvent(root, manifest.runId, {
    taskId: "sender",
    eventKind: "progress",
    message: "The interface is implemented.",
  });
  const remainder = await readRunEvents(root, manifest.runId, {
    cursor: page.nextCursor,
  });
  assert.deepEqual(
    remainder.events.map((event) => event.eventId),
    [second.eventId, third.eventId],
  );
  assert.equal(remainder.nextCursor, undefined);

  const relevant = await readRunEvents(root, manifest.runId, {
    recipient: "recipient",
    path: "src/api.ts",
  });
  assert.deepEqual(
    relevant.events.map((event) => event.eventId),
    [first.eventId],
  );
  assert.deepEqual(
    (
      await readRunEvents(root, manifest.runId, { eventKind: "risk" })
    ).events.map((event) => event.eventId),
    [second.eventId],
  );

  const inbox = await readRunMessages(root, manifest.runId, "recipient");
  assert.deepEqual(inbox.messages, [handoff]);
  assert.deepEqual(
    (
      await readRunMessages(root, manifest.runId, "recipient", {
        cursor: handoff.messageId,
      })
    ).messages,
    [],
  );
  assert.deepEqual(
    (await readRunMessages(root, manifest.runId, "sender")).messages,
    [],
  );

  await rejectsWithCode(
    () =>
      sendRunMessage(root, manifest.runId, {
        senderTaskId: "sender",
        recipientTaskId: "missing",
        message: "No such task",
      }),
    "unknown_task",
  );
  await rejectsWithCode(
    () =>
      publishRunEvent(root, manifest.runId, {
        taskId: "sender",
        eventKind: "handoff",
        message: "Unknown recipient",
        recipients: ["missing"],
      }),
    "unknown_task",
  );
  await rejectsWithCode(
    () => readRunEvents(root, manifest.runId, { cursor: "not-a-cursor" }),
    "invalid_argument",
  );
});

test("accepts coordination only while a run is owned", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "worker" }] }),
  );
  const event = {
    taskId: "worker",
    eventKind: "progress",
    message: "Started the assignment.",
  } as const;

  // A worker publishes without the orchestrator's ownership capability, so an
  // unowned run is the only thing that keeps a finished run immutable.
  await rejectsWithCode(
    () => publishRunEvent(root, manifest.runId, event),
    "ownership",
  );

  const ownership = await acquireRunOwnership(root, manifest.runId);
  assert.equal(
    (await publishRunEvent(root, manifest.runId, event)).eventId,
    "000001",
  );

  await releaseRunOwnership(root, ownership);
  await rejectsWithCode(
    () => publishRunEvent(root, manifest.runId, event),
    "ownership",
  );
  // Published records stay readable after the run is released.
  assert.equal((await readRunEvents(root, manifest.runId)).events.length, 1);
});

test("bounds one coordination page by size and retains the rest", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });
  const message = "m".repeat(RUN_COORDINATION_MAX_TEXT_BYTES);
  const published = 6;
  for (let index = 0; index < published; index += 1) {
    await publishRunEvent(root, manifest.runId, {
      taskId: "worker",
      eventKind: "progress",
      message,
    });
  }

  const page = await readRunEvents(root, manifest.runId);
  assert.ok(page.events.length > 0);
  assert.ok(page.events.length < published);
  assert.ok(
    Buffer.byteLength(JSON.stringify(page.events)) <=
      RUN_COORDINATION_MAX_PAGE_BYTES,
  );
  const cursor = page.nextCursor;
  assert.equal(cursor, page.events.at(-1)?.eventId);
  assert.ok(cursor !== undefined);

  const rest = await readRunEvents(root, manifest.runId, { cursor });
  assert.equal(page.events.length + rest.events.length, published);
});

test("counts JSON array overhead in coordination pages", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });
  const sample = await publishRunEvent(root, manifest.runId, {
    taskId: "worker",
    eventKind: "progress",
    message: "m".repeat(1000),
  });
  // Four records whose contents sum to two bytes below the limit exceed it by
  // one byte once the array brackets and separators are serialized.
  const recordOverhead =
    Buffer.byteLength(JSON.stringify(sample)) - sample.message.length;
  const messageBytes = RUN_COORDINATION_MAX_PAGE_BYTES - 2 - 4 * recordOverhead;
  const baseLength = Math.floor(messageBytes / 4);
  const remainder = messageBytes % 4;
  const lengths = Array.from(
    { length: 4 },
    (_unused, index) => baseLength + (index < remainder ? 1 : 0),
  );
  assert.ok(
    lengths.every((length) => length <= RUN_COORDINATION_MAX_TEXT_BYTES),
  );

  for (const length of lengths) {
    await publishRunEvent(root, manifest.runId, {
      taskId: "worker",
      eventKind: "progress",
      message: "m".repeat(length),
    });
  }

  const page = await readRunEvents(root, manifest.runId, {
    cursor: sample.eventId,
  });
  assert.equal(page.events.length, 3);
  assert.ok(
    Buffer.byteLength(JSON.stringify(page.events)) <=
      RUN_COORDINATION_MAX_PAGE_BYTES,
  );
});

test("arbitrates concurrent coordination publishers", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, {
    tasks: [{ id: "worker" }, { id: "peer" }],
  });

  const published = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) =>
      publishRunEvent(root, manifest.runId, {
        taskId: index % 2 === 0 ? "worker" : "peer",
        eventKind: "progress",
        message: `Fact ${index}.`,
      }),
    ),
  );

  // Every publisher claims its own sequence number, densely and exactly once.
  assert.deepEqual(published.map((event) => event.eventId).sort(), [
    "000001",
    "000002",
    "000003",
    "000004",
    "000005",
    "000006",
    "000007",
    "000008",
  ]);

  // Paging one record at a time delivers all of them, in sequence order, from
  // the run-global journal.
  const delivered: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readRunEvents(root, manifest.runId, {
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    delivered.push(...page.events.map((event) => event.message));
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    delivered,
    [...published]
      .sort((left, right) => left.eventId.localeCompare(right.eventId))
      .map((event) => event.message),
  );
});

test("an inbox poll advances past records it is never given", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, {
    tasks: [{ id: "other" }, { id: "worker" }],
  });
  // Events and another task's mail share the journal with this inbox.
  for (let index = 0; index < 3; index += 1) {
    await publishRunEvent(root, manifest.runId, {
      taskId: "worker",
      eventKind: "progress",
      message: `Step ${index}.`,
    });
  }
  const aside = await sendRunMessage(root, manifest.runId, {
    senderTaskId: "worker",
    recipientTaskId: "other",
    message: "Addressed to the other task.",
  });

  // Nothing is addressed to this worker, but the poll still reports where it
  // read to, so the next one does not examine the whole journal again.
  const empty = await readRunMessages(root, manifest.runId, "worker");
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.nextCursor, aside.messageId);

  // Polling from that position is idle, and ends rather than repeating.
  const idle = await readRunMessages(root, manifest.runId, "worker", {
    cursor: empty.nextCursor,
  });
  assert.deepEqual(idle.messages, []);
  assert.equal(idle.nextCursor, undefined);

  const mail = await sendRunMessage(root, manifest.runId, {
    senderTaskId: "other",
    recipientTaskId: "worker",
    message: "Please consume the shared interface.",
  });
  const delivered = await readRunMessages(root, manifest.runId, "worker", {
    cursor: empty.nextCursor,
  });
  assert.deepEqual(
    delivered.messages.map((record) => record.messageId),
    [mail.messageId],
  );
  assert.equal(delivered.nextCursor, undefined);
});

test("publishes a coordination record and its identifier as one act", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });
  const journal = join(root, "runs", manifest.runId, "coordination");
  const event = {
    taskId: "worker",
    eventKind: "progress",
    message: "One bounded fact.",
  } as const;
  const first = await publishRunEvent(root, manifest.runId, event);
  assert.equal(first.eventId, "000001");

  // A publisher that fails reserves nothing: no identifier names a record that
  // a reader could be handed a cursor past before it exists.
  await rejectsWithCode(
    () =>
      publishRunEvent(root, manifest.runId, {
        ...event,
        message: "m".repeat(RUN_COORDINATION_MAX_TEXT_BYTES),
        paths: Array.from({ length: RUN_COORDINATION_MAX_ITEMS }, () =>
          "p".repeat(RUN_COORDINATION_MAX_ITEM_BYTES),
        ),
      }),
    "record_too_large",
  );
  assert.deepEqual(await readdir(journal), ["000001.json"]);

  const second = await publishRunEvent(root, manifest.runId, event);
  assert.equal(second.eventId, "000002");
  const page = await readRunEvents(root, manifest.runId, {
    cursor: first.eventId,
  });
  assert.deepEqual(
    page.events.map((record) => record.eventId),
    [second.eventId],
  );
});

test("bounds one coordination record below one page", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });

  // Field bounds alone permit a record far larger than a page, so the whole
  // record is bounded when it is published.
  await rejectsWithCode(
    () =>
      publishRunEvent(root, manifest.runId, {
        taskId: "worker",
        eventKind: "interface",
        message: "One bounded fact.",
        symbols: Array.from({ length: RUN_COORDINATION_MAX_ITEMS }, () =>
          "s".repeat(RUN_COORDINATION_MAX_ITEM_BYTES),
        ),
      }),
    "record_too_large",
  );

  const published = await publishRunEvent(root, manifest.runId, {
    taskId: "worker",
    eventKind: "interface",
    message: "m".repeat(RUN_COORDINATION_MAX_TEXT_BYTES),
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(published)) <=
      RUN_COORDINATION_MAX_RECORD_BYTES,
  );

  // Which is what makes the page bound hold for a page of one record too.
  const page = await readRunEvents(root, manifest.runId, { limit: 1 });
  assert.deepEqual(
    page.events.map((record) => record.eventId),
    [published.eventId],
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(page.events)) <=
      RUN_COORDINATION_MAX_PAGE_BYTES,
  );
});

test("refuses a coordination record grown past its bound on disk", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });
  const published = await publishRunEvent(root, manifest.runId, {
    taskId: "worker",
    eventKind: "progress",
    message: "One bounded fact.",
  });
  const path = join(
    root,
    "runs",
    manifest.runId,
    "coordination",
    `${published.eventId}.json`,
  );
  await rm(path);
  await writeFile(
    path,
    `${JSON.stringify({
      ...published,
      message: "m".repeat(RUN_COORDINATION_MAX_RECORD_BYTES),
    })}\n`,
  );

  await rejectsWithCode(
    () => readRunEvents(root, manifest.runId),
    "invalid_record",
  );
});

test("refuses coordination beyond the retained record limit", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest } = await ownedRun(t, root, { tasks: [{ id: "worker" }] });
  const event = {
    taskId: "worker",
    eventKind: "progress",
    message: "One bounded fact.",
  } as const;
  for (let index = 0; index < RUN_COORDINATION_MAX_RECORDS; index += 1) {
    await publishRunEvent(root, manifest.runId, event);
  }

  await rejectsWithCode(
    () => publishRunEvent(root, manifest.runId, event),
    "retention_limit",
  );
});

test("lists retained capacity oldest first with slots and ownership", async (t) => {
  const root = await temporaryStateRoot(t);
  assert.deepEqual(await listRetainedRuns(root), []);

  const first = await createRun(root, normalizeGraph({ tasks: [{ id: "a" }] }));
  const second = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "b" }] }),
  );
  const ownership = await acquireRunOwnership(root, second.runId);

  const listed = await listRetainedRuns(root);
  assert.deepEqual(
    listed.map((entry) => ({
      runId: entry.runId,
      slot: entry.slot,
      owned: entry.owned,
    })),
    [
      { runId: first.runId, slot: 0, owned: false },
      { runId: second.runId, slot: 1, owned: true },
    ],
  );
  assert.equal(listed[0]?.createdAt, first.createdAt);
  await releaseRunOwnership(root, ownership);
});

test("deletes a run with its capacity slot and readmits work", async (t) => {
  const root = await temporaryStateRoot(t);
  const kept = await createRun(root, normalizeGraph({ tasks: [{ id: "a" }] }));
  const removed = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "b" }] }),
    2,
  );

  assert.equal(await deleteRun(root, removed.runId), true);
  // Nothing is left of the run, and its capacity is free again rather than
  // stranded: run directories and slots still agree, so the store admits work.
  await rejectsWithCode(() => readRun(root, removed.runId), "not_found");
  assert.deepEqual(
    (await listRetainedRuns(root)).map((entry) => entry.runId),
    [kept.runId],
  );
  const replacement = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "c" }] }),
    2,
  );
  assert.notEqual(replacement.runId, removed.runId);

  // Deleting is idempotent, and never invents a run to delete.
  assert.equal(await deleteRun(root, removed.runId), false);
  await rejectsWithCode(
    () => deleteRun(root, "not-a-run-id"),
    "invalid_identifier",
  );
});

test("lists a run it cannot read instead of hiding every other run", async (t) => {
  const root = await temporaryStateRoot(t);
  const broken = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "a" }] }),
  );
  const intact = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "b" }] }),
  );
  await writeFile(join(root, "runs", broken.runId, "run.json"), "{ not json");

  // This listing is read when the store is already in trouble, so one
  // unreadable run must not defeat it. The entry still names the run.
  assert.deepEqual(await listRetainedRuns(root), [
    { runId: intact.runId, slot: 1, createdAt: intact.createdAt, owned: false },
    { runId: broken.runId, slot: 0, owned: false },
  ]);
  assert.equal(await deleteRun(root, broken.runId), true);
  assert.deepEqual(
    (await listRetainedRuns(root)).map((entry) => entry.runId),
    [intact.runId],
  );
});

test("refuses to delete a run an orchestrator still holds", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  const ownership = await acquireRunOwnership(root, manifest.runId);

  await rejectsWithCode(() => deleteRun(root, manifest.runId), "ownership");
  assert.deepEqual(await readRun(root, manifest.runId), manifest);

  await releaseRunOwnership(root, ownership);
  assert.equal(await deleteRun(root, manifest.runId), true);
});

test("releases a slot stranded by an interrupted creation", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  // An interrupted creation leaves the slot without its run directory, which
  // holds capacity that only an explicit deletion may reclaim.
  await rm(join(root, "runs", manifest.runId), { recursive: true });

  assert.deepEqual(await listRetainedRuns(root), [
    { runId: manifest.runId, slot: 0, owned: false },
  ]);
  assert.equal(await deleteRun(root, manifest.runId), true);
  assert.deepEqual(await listRetainedRuns(root), []);
});

test("refuses new runs at the retained-state limit", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });

  await createRun(root, graph, 2);
  await createRun(root, graph, 2);
  await rejectsWithCode(() => createRun(root, graph, 2), "retention_limit");
});

test("concurrent creation fills the available capacity exactly once", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const store = join(root, `store-${attempt}`);
    const results = await Promise.allSettled([
      createRun(store, graph, 1),
      createRun(store, graph, 1),
    ]);
    const created = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    assert.equal(created.length, 1);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof RunStoreError);
        assert.equal(result.reason.code, "retention_limit");
      }
    }
    const entries = await readdir(join(store, "runs"));
    assert.deepEqual(
      entries.filter((entry) => entry !== "slots"),
      [created[0]?.runId],
    );
  }
});

test("a claimed capacity slot is never released by elapsed time", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });
  const slots = join(root, "runs", "slots");
  await mkdir(slots, { recursive: true });
  await writeFile(
    join(slots, "0.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "run-slot",
      runId: "8a2b0f2c-2c1d-4d1e-9a3f-6b5c4d3e2f10",
    })}\n`,
  );
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(join(slots, "0.json"), stale, stale);

  await rejectsWithCode(() => createRun(root, graph, 1), "retention_limit");
  assert.deepEqual(
    (await readdir(join(root, "runs"))).filter((entry) => entry !== "slots"),
    [],
  );
});

test("an interrupted creation reports its slot as reclaimable", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });
  const slots = join(root, "runs", "slots");
  await mkdir(slots, { recursive: true });
  await writeFile(
    join(slots, "0.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "run-slot",
      runId: "8a2b0f2c-2c1d-4d1e-9a3f-6b5c4d3e2f10",
    })}\n`,
  );

  await assert.rejects(createRun(root, graph, 1), (error: unknown) => {
    assert.ok(error instanceof RunStoreError);
    assert.equal(error.code, "retention_limit");
    assert.match(error.message, /1 of them belong to runs that were never/);
    return true;
  });

  await rm(join(slots, "0.json"));
  const created = await createRun(root, graph, 1);
  assert.equal((await readRun(root, created.runId)).runId, created.runId);
});

test("a lowered limit cannot admit work past the new limit", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });
  const created = [];
  for (let index = 0; index < 6; index += 1) {
    created.push(await createRun(root, graph, 6));
  }
  // Retire every run but the one holding the highest slot, so the survivor's
  // slot sits outside the range a claim under the lowered limit searches.
  for (let index = 0; index < 5; index += 1) {
    await rm(join(root, "runs", `${created[index]?.runId}`), {
      recursive: true,
    });
    await rm(join(root, "runs", "slots", `${index}.json`));
  }

  const results = await Promise.allSettled([
    createRun(root, graph, 2),
    createRun(root, graph, 2),
  ]);

  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof RunStoreError);
    assert.equal(result.reason.code, "retention_limit");
    assert.match(
      result.reason.message,
      /1 published run\(s\) hold a capacity slot at or above/,
    );
  }
  assert.deepEqual(
    (await readdir(join(root, "runs"))).filter((entry) => entry !== "slots"),
    [created[5]?.runId],
  );
});

test("deleted slot files cannot push the store past its limit", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });

  await createRun(root, graph, 1);
  await rm(join(root, "runs", "slots"), { recursive: true });

  await rejectsWithCode(() => createRun(root, graph, 1), "retention_limit");
});

test("a run without its slot admits nobody rather than everybody", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });
  const published = await createRun(root, graph, 2);
  await rm(join(root, "runs", "slots"), { recursive: true });

  const results = await Promise.allSettled([
    createRun(root, graph, 2),
    createRun(root, graph, 2),
  ]);

  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof RunStoreError);
    assert.equal(result.reason.code, "retention_limit");
    assert.match(
      result.reason.message,
      /1 published run\(s\) have no capacity/,
    );
  }
  assert.deepEqual(
    (await readdir(join(root, "runs"))).filter((entry) => entry !== "slots"),
    [published.runId],
  );
});

test("a slot that names no owner is reported as reclaimable", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({ tasks: [{ id: "task" }] });
  const slots = join(root, "runs", "slots");
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, "0.json"), "");

  await assert.rejects(createRun(root, graph, 1), (error: unknown) => {
    assert.ok(error instanceof RunStoreError);
    assert.equal(error.code, "retention_limit");
    assert.match(error.message, /1 of them belong to runs that were never/);
    return true;
  });
});

test("a claimed slot always names the run that holds it", async (t) => {
  const root = await temporaryStateRoot(t);
  const created = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
    2,
  );
  const slots = join(root, "runs", "slots");

  assert.deepEqual(await readdir(slots), ["0.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(slots, "0.json"), "utf8")), {
    schemaVersion: 1,
    kind: "run-slot",
    runId: created.runId,
  });
});

test("rejects the filesystem root as a state root", async () => {
  await rejectsWithCode(
    () =>
      createRun(
        parse(process.cwd()).root,
        normalizeGraph({ tasks: [{ id: "task" }] }),
      ),
    "invalid_argument",
  );
});

test("atomically replaces parent-owned node state", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });

  const running = await writeNodeState(
    root,
    manifest.runId,
    "task",
    "running",
    ownership,
  );
  const reopened = await readNodeState(root, manifest.runId, "task");

  assert.equal(running.status, "running");
  assert.deepEqual(reopened, running);
  assert.equal(reopened.attempt, 1);
});

test("publishes one immutable terminal output", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  await writeNodeState(root, manifest.runId, "task", "running", ownership);

  const published = await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "succeeded",
      output: {
        ...nodeOutput("Implemented the change"),
        changedFiles: [
          { path: "src/file.ts", description: "Implemented the change" },
        ],
      },
    },
    ownership,
  );
  await writeNodeState(root, manifest.runId, "task", "succeeded", ownership);

  assert.equal(published.schemaVersion, 1);
  assert.deepEqual(
    await readNodeOutput(root, manifest.runId, "task"),
    published,
  );
  assert.equal(
    (await readNodeState(root, manifest.runId, "task")).status,
    "succeeded",
  );
  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "succeeded",
          output: nodeOutput("Replacement"),
        },
        ownership,
      ),
    "record_exists",
  );
});

test("publishes immutable output without a same-process race", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });

  const results = await Promise.allSettled([
    publishNodeOutput(
      root,
      manifest.runId,
      {
        taskId: "task",
        status: "failed",
        diagnostics: "first",
      },
      ownership,
    ),
    publishNodeOutput(
      root,
      manifest.runId,
      {
        taskId: "task",
        status: "failed",
        diagnostics: "second",
      },
      ownership,
    ),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.reason instanceof RunStoreError);
  assert.equal(rejected.reason.code, "record_exists");
});

test("validates diagnostics from untyped callers before publication", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });

  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "failed",
          diagnostics: 42 as unknown as string,
        },
        ownership,
      ),
    "invalid_argument",
  );
  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "not_found",
  );
});

test("rejects malformed structured reports from untyped callers", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  await writeNodeState(root, manifest.runId, "task", "running", ownership);

  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "succeeded",
          output: { summary: "incomplete" } as unknown as NodeOutput,
        },
        ownership,
      ),
    "invalid_argument",
  );
  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "succeeded",
          output: { ...nodeOutput(), blockers: ["Not complete"] },
        },
        ownership,
      ),
    "invalid_argument",
  );
  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "not_found",
  );
});

test("rejects incompatible and unknown node-output envelope fields", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  await writeNodeState(root, manifest.runId, "task", "running", ownership);
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "succeeded",
      output: nodeOutput(),
    },
    ownership,
  );
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  const outputPath = join(
    root,
    "runs",
    manifest.runId,
    "outputs",
    `${task.key}.json`,
  );
  const original = JSON.parse(await readFile(outputPath, "utf8")) as Record<
    string,
    unknown
  >;

  await writeFile(
    outputPath,
    JSON.stringify({ ...original, schemaVersion: 2 }),
  );
  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "invalid_record",
  );
  await writeFile(outputPath, JSON.stringify({ ...original, extra: true }));
  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "invalid_record",
  );
});

test("rejects output that conflicts with terminal node state", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "failed",
    },
    ownership,
  );
  await writeNodeState(root, manifest.runId, "task", "failed", ownership);

  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "succeeded",
          output: nodeOutput(),
        },
        ownership,
      ),
    "invalid_record",
  );
});

test("enforces graph transitions and requires output before terminal state", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "first" }, { id: "second", needs: ["first"] }],
  });

  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "second", "running", ownership),
    "invalid_record",
  );
  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "first", "succeeded", ownership),
    "invalid_record",
  );

  await writeNodeState(root, manifest.runId, "first", "running", ownership);
  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "first", "succeeded", ownership),
    "invalid_record",
  );
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "first",
      status: "succeeded",
      output: nodeOutput(),
    },
    ownership,
  );
  await writeNodeState(root, manifest.runId, "first", "succeeded", ownership);
  assert.equal(
    (await writeNodeState(root, manifest.runId, "second", "running", ownership))
      .status,
    "running",
  );
});

test("does not let terminal state disagree with a published output", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  await writeNodeState(root, manifest.runId, "task", "running", ownership);
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "succeeded",
      output: nodeOutput(),
    },
    ownership,
  );

  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "task", "failed", ownership),
    "invalid_record",
  );
  assert.equal(
    (await readNodeState(root, manifest.runId, "task")).status,
    "running",
  );
});

test("uses opaque task keys instead of task IDs as path components", async (t) => {
  const root = await temporaryStateRoot(t);
  const ids = ["../escape", "a/b", "/absolute", "task with spaces", "雪"];
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: ids.map((id) => ({ id })) }),
  );

  for (const task of manifest.graph.tasks) {
    assert.match(task.key, /^task-[0-9a-f-]+$/);
    assert.equal(task.key.includes(task.id), false);
    assert.equal(
      (await readNodeState(root, manifest.runId, task.id)).taskId,
      task.id,
    );
  }

  const runDirectory = join(root, "runs", manifest.runId);
  assert.equal(
    await stat(join(runDirectory, "run.json")).then(() => true),
    true,
  );
  await assert.rejects(() => stat(join(root, "escape")));
});

test("rejects invalid and unknown identifiers before constructing record paths", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "known" }] }),
  );

  await rejectsWithCode(() => readRun(root, "../escape"), "invalid_identifier");
  await rejectsWithCode(
    () => readNodeState(root, manifest.runId, "unknown"),
    "unknown_task",
  );
});

test("bounds diagnostics and records on write and read", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });

  await rejectsWithCode(
    () =>
      publishNodeOutput(
        root,
        manifest.runId,
        {
          taskId: "task",
          status: "failed",
          diagnostics: "x".repeat(RUN_STORE_MAX_RECORD_BYTES),
        },
        ownership,
      ),
    "invalid_argument",
  );

  const task = manifest.graph.tasks[0];
  assert.ok(task);
  const statePath = join(
    root,
    "runs",
    manifest.runId,
    "nodes",
    `${task.key}.json`,
  );
  await writeFile(statePath, "x".repeat(RUN_STORE_MAX_RECORD_BYTES + 1));
  await rejectsWithCode(
    () => readNodeState(root, manifest.runId, "task"),
    "record_too_large",
  );
});

test("reports malformed records without hiding valid neighboring records", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "bad" }, { id: "good" }] }),
  );
  const bad = manifest.graph.tasks.find((task) => task.id === "bad");
  assert.ok(bad);
  await writeFile(
    join(root, "runs", manifest.runId, "nodes", `${bad.key}.json`),
    "{not-json",
  );

  await rejectsWithCode(
    () => readNodeState(root, manifest.runId, "bad"),
    "malformed_record",
  );
  assert.equal(
    (await readNodeState(root, manifest.runId, "good")).status,
    "pending",
  );
});

test("rejects invalid UTF-8 records", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  const statePath = join(
    root,
    "runs",
    manifest.runId,
    "nodes",
    `${task.key}.json`,
  );
  await writeFile(
    statePath,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  );

  await rejectsWithCode(
    () => readNodeState(root, manifest.runId, "task"),
    "malformed_record",
  );
});

test("rejects records whose embedded identity does not match their path", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  const statePath = join(
    root,
    "runs",
    manifest.runId,
    "nodes",
    `${task.key}.json`,
  );
  const record = JSON.parse(await readFile(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  record.taskId = "other";
  await writeFile(statePath, JSON.stringify(record));

  await rejectsWithCode(
    () => readNodeState(root, manifest.runId, "task"),
    "invalid_record",
  );
});

test("ignores abandoned temporary files", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  await writeFile(
    join(
      root,
      "runs",
      manifest.runId,
      "outputs",
      `.${task.key}.json.abandoned.tmp`,
    ),
    "{partial",
  );

  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "not_found",
  );
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "failed",
    },
    ownership,
  );
  assert.equal(
    (await readNodeOutput(root, manifest.runId, "task")).status,
    "failed",
  );
});

test("creates run directories and records with restrictive permissions", async (t) => {
  const root = await temporaryStateRoot(t);
  const { manifest, ownership } = await ownedRun(t, root, {
    tasks: [{ id: "task" }],
  });
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  await publishNodeOutput(
    root,
    manifest.runId,
    {
      taskId: "task",
      status: "failed",
    },
    ownership,
  );
  const runDirectory = join(root, "runs", manifest.runId);

  assert.equal((await stat(join(root, "runs"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "runs", "slots"))).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(root, "runs", "slots", "0.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(runDirectory, "nodes"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(runDirectory, "outputs"))).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(runDirectory, "run.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(join(runDirectory, "nodes", `${task.key}.json`))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(join(runDirectory, "outputs", `${task.key}.json`))).mode &
      0o777,
    0o600,
  );
  assert.equal(
    (await stat(join(runDirectory, "coordination"))).mode & 0o777,
    0o700,
  );
  const event = await publishRunEvent(root, manifest.runId, {
    taskId: "task",
    eventKind: "progress",
    message: "Published a coordination fact.",
  });
  assert.equal(
    (await stat(join(runDirectory, "coordination", `${event.eventId}.json`)))
      .mode & 0o777,
    0o600,
  );
});

test("rejects non-JSON graph payloads", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({
    tasks: [{ id: "task", payload: { createdAt: new Date() } }],
  });
  await rejectsWithCode(() => createRun(root, graph), "invalid_argument");

  class ArrayWithCustomSerialization extends Array<string> {
    toJSON(): object {
      return { replaced: true };
    }
  }
  const customArrayGraph = normalizeGraph({
    tasks: [
      {
        id: "task",
        payload: new ArrayWithCustomSerialization("original"),
      },
    ],
  });
  await rejectsWithCode(
    () => createRun(root, customArrayGraph),
    "invalid_argument",
  );
});
