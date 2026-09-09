import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import {
  loadWorkerGraphConfiguration,
  WORKER_GRAPH_CONFIG_FILENAME,
  WORKER_GRAPH_CONFIG_MAX_BYTES,
  WorkerGraphConfigurationError,
} from "../src/config.js";

async function directories(t: test.TestContext): Promise<{
  agentDirectory: string;
  workingDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-graph-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    agentDirectory: join(root, "agent"),
    workingDirectory: join(root, "checkout"),
  };
}

async function writeConfiguration(
  agentDirectory: string,
  value: unknown,
): Promise<void> {
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(
    join(agentDirectory, WORKER_GRAPH_CONFIG_FILENAME),
    JSON.stringify(value),
  );
}

function validConfiguration(stateRoot?: string): unknown {
  return {
    schemaVersion: 1,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    profiles: {
      writer: {
        provider: "test-provider",
        model: "test-model",
        thinkingLevel: "medium",
        tools: ["read", "edit", "write"],
      },
    },
  };
}

test("loads strict profiles and defaults state beneath the Pi agent directory", async (t) => {
  const paths = await directories(t);
  await writeConfiguration(paths.agentDirectory, validConfiguration());

  const configuration = await loadWorkerGraphConfiguration(paths);

  assert.equal(
    configuration.stateRoot,
    join(paths.agentDirectory, "worker-graph"),
  );
  assert.equal(configuration.maxRetainedRuns, 64);
  assert.deepEqual(configuration.profiles.writer, {
    provider: "test-provider",
    model: "test-model",
    thinkingLevel: "medium",
    tools: ["edit", "read", "write"],
  });
  assert.ok(Object.isFrozen(configuration));
  assert.ok(Object.isFrozen(configuration.profiles));
  assert.ok(Object.isFrozen(configuration.profiles.writer));
});

test("resolves an explicit relative state root against the agent directory", async (t) => {
  const paths = await directories(t);
  await writeConfiguration(paths.agentDirectory, validConfiguration("state"));

  const configuration = await loadWorkerGraphConfiguration(paths);

  assert.equal(configuration.stateRoot, join(paths.agentDirectory, "state"));
});

test("loads and bounds an explicit retained-run limit", async (t) => {
  const paths = await directories(t);
  await writeConfiguration(paths.agentDirectory, {
    ...(validConfiguration() as object),
    maxRetainedRuns: 2,
  });

  assert.equal((await loadWorkerGraphConfiguration(paths)).maxRetainedRuns, 2);

  for (const maxRetainedRuns of [0, 257, 1.5, "2"]) {
    await writeConfiguration(paths.agentDirectory, {
      ...(validConfiguration() as object),
      maxRetainedRuns,
    });
    await assert.rejects(
      loadWorkerGraphConfiguration(paths),
      (error: unknown) =>
        error instanceof WorkerGraphConfigurationError &&
        error.code === "invalid",
    );
  }
});

test("rejects state roots inside the target checkout", async (t) => {
  const paths = await directories(t);
  await writeConfiguration(
    paths.agentDirectory,
    validConfiguration(paths.workingDirectory),
  );

  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "unsafe_state_root",
  );
});

test("rejects state roots that enter the checkout through a symlink", async (t) => {
  const paths = await directories(t);
  const checkoutState = join(paths.workingDirectory, "state");
  const linkedState = join(paths.agentDirectory, "linked-state");
  await mkdir(checkoutState, { recursive: true });
  await mkdir(paths.agentDirectory, { recursive: true });
  await symlink(
    checkoutState,
    linkedState,
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeConfiguration(
    paths.agentDirectory,
    validConfiguration(linkedState),
  );

  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "unsafe_state_root",
  );
});

test("rejects the filesystem root as a state directory", async (t) => {
  const paths = await directories(t);
  await writeConfiguration(
    paths.agentDirectory,
    validConfiguration(parse(paths.agentDirectory).root),
  );

  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "invalid",
  );
});

test("rejects missing, malformed, oversized, and unknown configuration", async (t) => {
  const paths = await directories(t);
  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "missing",
  );

  await writeConfiguration(paths.agentDirectory, validConfiguration());
  const path = join(paths.agentDirectory, WORKER_GRAPH_CONFIG_FILENAME);

  await writeFile(path, "{");
  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "malformed",
  );

  await writeFile(
    path,
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  );
  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "malformed",
  );

  await writeFile(path, "x".repeat(WORKER_GRAPH_CONFIG_MAX_BYTES + 1));
  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "too_large",
  );

  await writeConfiguration(paths.agentDirectory, {
    ...(validConfiguration() as object),
    unexpected: true,
  });
  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "invalid",
  );
});

test("rejects unknown profile fields", async (t) => {
  const paths = await directories(t);
  const configuration = validConfiguration() as {
    profiles: { writer: Record<string, unknown> };
  };
  configuration.profiles.writer.secret = "must not be accepted";
  await writeConfiguration(paths.agentDirectory, configuration);

  await assert.rejects(
    loadWorkerGraphConfiguration(paths),
    (error: unknown) =>
      error instanceof WorkerGraphConfigurationError &&
      error.code === "invalid",
  );
});
