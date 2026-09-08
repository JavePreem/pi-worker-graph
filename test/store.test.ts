import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunStoreErrorCode } from "../src/index.js";
import {
  createRun,
  normalizeGraph,
  publishNodeOutput,
  RUN_STORE_MAX_RECORD_BYTES,
  RunStoreError,
  readNodeOutput,
  readNodeState,
  readRun,
  writeNodeState,
} from "../src/index.js";

async function temporaryStateRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-graph-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
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

test("atomically replaces parent-owned node state", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );

  const running = await writeNodeState(root, manifest.runId, "task", "running");
  const reopened = await readNodeState(root, manifest.runId, "task");

  assert.equal(running.status, "running");
  assert.deepEqual(reopened, running);
  assert.equal(reopened.attempt, 1);
});

test("publishes one immutable terminal output", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  await writeNodeState(root, manifest.runId, "task", "running");

  const published = await publishNodeOutput(root, manifest.runId, {
    taskId: "task",
    status: "succeeded",
    output: { summary: "done", files: ["src/file.ts"] },
  });
  await writeNodeState(root, manifest.runId, "task", "succeeded");

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
      publishNodeOutput(root, manifest.runId, {
        taskId: "task",
        status: "succeeded",
        output: { summary: "replacement" },
      }),
    "record_exists",
  );
});

test("publishes immutable output without a same-process race", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );

  const results = await Promise.allSettled([
    publishNodeOutput(root, manifest.runId, {
      taskId: "task",
      status: "failed",
      diagnostics: "first",
    }),
    publishNodeOutput(root, manifest.runId, {
      taskId: "task",
      status: "failed",
      diagnostics: "second",
    }),
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
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );

  await rejectsWithCode(
    () =>
      publishNodeOutput(root, manifest.runId, {
        taskId: "task",
        status: "failed",
        diagnostics: 42 as unknown as string,
      }),
    "invalid_argument",
  );
  await rejectsWithCode(
    () => readNodeOutput(root, manifest.runId, "task"),
    "not_found",
  );
});

test("rejects output that conflicts with terminal node state", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  await publishNodeOutput(root, manifest.runId, {
    taskId: "task",
    status: "failed",
  });
  await writeNodeState(root, manifest.runId, "task", "failed");

  await rejectsWithCode(
    () =>
      publishNodeOutput(root, manifest.runId, {
        taskId: "task",
        status: "succeeded",
      }),
    "invalid_record",
  );
});

test("enforces graph transitions and requires output before terminal state", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({
      tasks: [{ id: "first" }, { id: "second", needs: ["first"] }],
    }),
  );

  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "second", "running"),
    "invalid_record",
  );
  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "first", "succeeded"),
    "invalid_record",
  );

  await writeNodeState(root, manifest.runId, "first", "running");
  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "first", "succeeded"),
    "invalid_record",
  );
  await publishNodeOutput(root, manifest.runId, {
    taskId: "first",
    status: "succeeded",
  });
  await writeNodeState(root, manifest.runId, "first", "succeeded");
  assert.equal(
    (await writeNodeState(root, manifest.runId, "second", "running")).status,
    "running",
  );
});

test("does not let terminal state disagree with a published output", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  await writeNodeState(root, manifest.runId, "task", "running");
  await publishNodeOutput(root, manifest.runId, {
    taskId: "task",
    status: "succeeded",
  });

  await rejectsWithCode(
    () => writeNodeState(root, manifest.runId, "task", "failed"),
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

test("bounds records on both write and read", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );

  await rejectsWithCode(
    () =>
      publishNodeOutput(root, manifest.runId, {
        taskId: "task",
        status: "failed",
        diagnostics: "x".repeat(RUN_STORE_MAX_RECORD_BYTES),
      }),
    "record_too_large",
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
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
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
  await publishNodeOutput(root, manifest.runId, {
    taskId: "task",
    status: "failed",
  });
  assert.equal(
    (await readNodeOutput(root, manifest.runId, "task")).status,
    "failed",
  );
});

test("creates run directories and records with restrictive permissions", async (t) => {
  const root = await temporaryStateRoot(t);
  const manifest = await createRun(
    root,
    normalizeGraph({ tasks: [{ id: "task" }] }),
  );
  const task = manifest.graph.tasks[0];
  assert.ok(task);
  await publishNodeOutput(root, manifest.runId, {
    taskId: "task",
    status: "failed",
  });
  const runDirectory = join(root, "runs", manifest.runId);

  assert.equal((await stat(join(root, "runs"))).mode & 0o777, 0o700);
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
});

test("rejects non-JSON graph payloads", async (t) => {
  const root = await temporaryStateRoot(t);
  const graph = normalizeGraph({
    tasks: [{ id: "task", payload: { createdAt: new Date() } }],
  });

  await rejectsWithCode(() => createRun(root, graph), "invalid_argument");
});
