import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { workerGraphConfig } from "./arms.mjs";
import {
  assertModelsServed,
  CONTAINER_PATH,
  installInContainer,
  makeAgentDirectory,
  prepareToolchain,
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

test("the carried directory is readable by the container's root", async () => {
  // `docker cp` preserves the host UID and the container drops every
  // capability, including CAP_DAC_OVERRIDE. A mode of 0600 owned by the host
  // user is then unreadable by Pi itself, which surfaces as "Model not found"
  // and an unauthenticated session rather than as a permission error. The
  // directory is what restricts access; the modes inside only have to let the
  // process that needs them in.
  //
  // Run under `umask 077`, because that is the case a mode passed to
  // `writeFile` or `mkdir` silently loses to.
  const before = process.umask(0o077);
  try {
    await fixtures(async ({ source, pkg }) => {
      const agent = await makeAgentDirectory({
        from: source,
        workerGraphConfig: workerGraphConfig("graph-luna", { provider: "p" }),
        packageTree: pkg,
        packageVersion: "0.1.0-dev.2",
        provider: "p",
        model: "m",
      });
      // Every step of the path Pi walks: the credentials, the settings that
      // name the package, and the tree itself behind two directories it has
      // to be able to search.
      for (const entry of [
        "auth.json",
        "settings.json",
        "worker-graph.json",
        "npm",
        "npm/node_modules/pi-worker-graph",
        "npm/node_modules/pi-worker-graph/package.json",
      ]) {
        const { mode } = await stat(path.join(agent.dir, entry));
        assert.ok(mode & 0o004, `${entry} is not readable by a foreign uid`);
      }
      const dir = await stat(agent.dir);
      assert.equal(
        dir.mode & 0o077,
        0,
        "the directory must be the restriction",
      );
      await agent.dispose();
    });
  } finally {
    process.umask(before);
  }
});

test("the toolchain tree is readable by the container's root too", async () => {
  // The same foreign-uid problem as the agent directory, and a worse failure:
  // `npm install` writes under the host umask and the tree is `docker cp`'d in
  // whole, so under `umask 077` Pi's own binary lands unreadable and every
  // cell dies at the version check before the arm has begun. Executability has
  // to survive the widening, or the binary is readable and still will not run.
  const before = process.umask(0o077);
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "bench-tools-"));
    await prepareToolchain({
      dir,
      piSpec: "@earendil-works/pi-coding-agent@0.85.1",
      packageSpec: "pi-worker-graph@0.1.0",
      install: async (cwd) => {
        await mkdir(path.join(cwd, "node_modules", ".bin"), {
          recursive: true,
        });
        await writeFile(
          path.join(cwd, "node_modules", ".bin", "pi"),
          "#!/bin/sh\n",
          {
            mode: 0o700,
          },
        );
        await writeFile(
          path.join(cwd, "package-lock.json"),
          JSON.stringify({ packages: {} }),
        );
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const bin = await stat(path.join(dir, "node_modules", ".bin", "pi"));
    assert.ok(bin.mode & 0o004, "pi is not readable by a foreign uid");
    assert.ok(bin.mode & 0o001, "pi is not executable by a foreign uid");
    const tree = await stat(path.join(dir, "node_modules"));
    assert.ok(
      tree.mode & 0o001,
      "the tree cannot be searched by a foreign uid",
    );
    await rm(dir, { recursive: true, force: true });
  } finally {
    process.umask(before);
  }
});

test("the carried directory is writable, not only readable", async () => {
  // Pi writes back into its own agent directory: a catalogue refresh rewrites
  // models-store.json, an OAuth arm rewrites auth.json when the token is
  // refreshed. The container's root cannot chown its way around a mode,
  // because CAP_CHOWN is dropped with the rest, so read-only files turn a
  // token refresh into EACCES and the same silent unauthenticated session.
  await fixtures(async ({ source, pkg }) => {
    await writeFile(path.join(source, "models-store.json"), "{}");
    const agent = await makeAgentDirectory({
      from: source,
      workerGraphConfig: undefined,
      packageTree: pkg,
      provider: "p",
      model: "m",
    });
    for (const entry of ["auth.json", "models-store.json"]) {
      const { mode } = await stat(path.join(agent.dir, entry));
      assert.ok(mode & 0o002, `${entry} is not writable by a foreign uid`);
    }
    await agent.dispose();
  });
});

test("pi is put on PATH, or a graph arm spawns no workers", async () => {
  // The package resolves Pi from its own location, and here the two live in
  // separate trees, so it falls through to spawning a bare `pi`. Without this
  // every worker fails to start and the arm is recorded as failing the task.
  const commands = [];
  await installInContainer(
    {
      exec: async (script) => {
        commands.push(script);
        return { code: 0, stdout: "pi 0.85.1", stderr: "" };
      },
      copyIn: async () => {},
    },
    { toolchainDir: "/t", agentDir: "/a" },
  );
  const linked = commands.findIndex((c) => c.includes("/usr/local/bin/pi"));
  const checked = commands.findIndex((c) => c.includes("command -v pi"));
  const ran = commands.findIndex((c) => c.includes("--version"));
  assert.ok(linked !== -1, "pi was never linked onto PATH");
  assert.ok(checked > linked, "the link was never verified");
  // Verified under the PATH Pi is started with. `container.exec` runs a login
  // shell, which sets a PATH of its own; Pi is started with no shell and hands
  // its environment to every worker. Checking the shell's PATH would pass on
  // an image whose workers still find no `pi`.
  assert.match(commands[checked], /^env -i PATH=/);
  assert.ok(
    commands[checked].includes(CONTAINER_PATH),
    "the check did not use the PATH the workers inherit",
  );
  // And run before it, so a toolchain that did not survive the copy is named
  // as that rather than as a PATH problem by way of a dangling symlink.
  assert.ok(ran !== -1 && ran < checked, "the binary was checked after PATH");
});
