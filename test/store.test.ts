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
  normalizeGraph,
  publishNodeOutput,
  RUN_STORE_MAX_RECORD_BYTES,
  RunStoreError,
  readNodeOutput,
  readNodeState,
  readRun,
  releaseRunOwnership,
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

  const mutationLock = join(root, "runs", manifest.runId, "mutation.lock");
  await mkdir(mutationLock);
  await rejectsWithCode(() => releaseRunOwnership(root, owner), "ownership");
  await rejectsWithCode(
    () => acquireRunOwnership(root, manifest.runId),
    "ownership",
  );
  await rm(mutationLock, { recursive: true });

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
  assert.equal(rejected.reason.code, "ownership");
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
