import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { workerGraphConfig } from "./arms.mjs";
import {
  assertModelsServed,
  makeAgentDirectory,
  readAgentSettings,
} from "./toolchain.mjs";

async function fixtures(run, { auth = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bench-toolchain-"));
  const source = path.join(root, "agent");
  const pkg = path.join(root, "package");
  await mkdir(source, { recursive: true });
  await mkdir(pkg, { recursive: true });
  if (auth) await writeFile(path.join(source, "auth.json"), "{}");
  await writeFile(
    path.join(source, "settings.json"),
    '{"defaultProvider":"github-copilot"}',
  );
  await writeFile(path.join(pkg, "package.json"), '{"name":"pi-worker-graph"}');
  try {
    await run({ source, pkg });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a graph arm gets the package where Pi actually looks for it", async () => {
  await fixtures(async ({ source, pkg }) => {
    const agent = await makeAgentDirectory({
      from: source,
      workerGraphConfig: workerGraphConfig("graph-luna", { provider: "p" }),
      packageTree: pkg,
      packageVersion: "0.1.0-dev.2",
      provider: "p",
      model: "gpt-5.6-sol",
    });
    // Both halves are needed: the tree under npm/node_modules, and the name in
    // settings.json. A tree Pi was never told to load is not loaded.
    assert.ok(
      existsSync(
        path.join(agent.dir, "npm/node_modules/pi-worker-graph/package.json"),
      ),
    );
    const settings = JSON.parse(
      await readFile(path.join(agent.dir, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.packages, ["npm:pi-worker-graph@0.1.0-dev.2"]);
    assert.equal(settings.defaultModel, "gpt-5.6-sol");
    assert.ok(existsSync(path.join(agent.dir, "worker-graph.json")));
    await agent.dispose();
  });
});

test("a solo arm gets neither the package nor a configuration", async () => {
  await fixtures(async ({ source, pkg }) => {
    const agent = await makeAgentDirectory({
      from: source,
      workerGraphConfig: undefined,
      packageTree: pkg,
      provider: "p",
      model: "gpt-5.6-luna",
    });
    assert.equal(existsSync(path.join(agent.dir, "npm")), false);
    assert.equal(existsSync(path.join(agent.dir, "worker-graph.json")), false);
    const settings = JSON.parse(
      await readFile(path.join(agent.dir, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.packages, []);
    await agent.dispose();
  });
});

test("nothing from the development box's own agent directory is carried", async () => {
  await fixtures(async ({ source, pkg }) => {
    await mkdir(path.join(source, "extensions"), { recursive: true });
    await writeFile(path.join(source, "presets.json"), "{}");
    const agent = await makeAgentDirectory({
      from: source,
      workerGraphConfig: undefined,
      packageTree: pkg,
      provider: "p",
      model: "m",
    });
    assert.equal(existsSync(path.join(agent.dir, "extensions")), false);
    assert.equal(existsSync(path.join(agent.dir, "presets.json")), false);
    await agent.dispose();
  });
});

test("an agent directory with no credentials fails before a container is started", async () => {
  await fixtures(
    async ({ source, pkg }) => {
      await assert.rejects(
        () =>
          makeAgentDirectory({
            from: source,
            workerGraphConfig: undefined,
            packageTree: pkg,
            provider: "p",
            model: "m",
          }),
        /cannot authenticate/,
      );
    },
    { auth: false },
  );
});

test("a graph arm without the package tree refuses rather than running unequipped", async () => {
  await fixtures(async ({ source }) => {
    await assert.rejects(
      () =>
        makeAgentDirectory({
          from: source,
          workerGraphConfig: workerGraphConfig("graph-sol", { provider: "p" }),
          provider: "p",
          model: "m",
        }),
      /needs the package tree/,
    );
  });
});

test("the provider is read from the directory that holds the credentials", async () => {
  await fixtures(async ({ source }) => {
    assert.equal(
      (await readAgentSettings(source)).defaultProvider,
      "github-copilot",
    );
    assert.deepEqual(await readAgentSettings(path.join(source, "nope")), {});
  });
});

test("an arm whose models the provider does not serve is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-models-"));
  await writeFile(
    path.join(dir, "models-store.json"),
    JSON.stringify({
      "azure-openai-responses": {
        models: [{ id: "gpt-5.6-luna" }, { id: "gpt-4o" }],
      },
    }),
  );
  await assert.rejects(
    assertModelsServed(dir, "azure-openai-responses", [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
    ]),
    /does not serve gpt-5\.6-sol/,
  );
  await assert.doesNotReject(
    assertModelsServed(dir, "azure-openai-responses", ["gpt-5.6-luna"]),
  );
});

test("a provider the catalogue does not mention is not judged", async () => {
  // The cache is evidence about providers it lists and a gap about the rest.
  // Refusing on a gap would block a provider whose catalogue was never fetched.
  const dir = await mkdtemp(path.join(tmpdir(), "bench-models-"));
  await writeFile(
    path.join(dir, "models-store.json"),
    JSON.stringify({ "github-copilot": { models: [{ id: "gpt-4o" }] } }),
  );
  await assert.doesNotReject(
    assertModelsServed(dir, "azure-openai-responses", ["gpt-5.6-sol"]),
  );
  // Nor is an agent directory with no catalogue at all.
  await assert.doesNotReject(
    assertModelsServed(
      await mkdtemp(path.join(tmpdir(), "bench-empty-")),
      "x",
      ["y"],
    ),
  );
});
