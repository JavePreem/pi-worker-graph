/**
 * Pi, and the package under test, inside the instance container.
 *
 * Built once on the host into a plain directory and copied into each
 * container. Installing per cell would put a registry fetch inside the
 * measurement and make a cell fail for a reason that has nothing to do with
 * the arm; baking an image layer would add ~14 GB per instance to a disk
 * budget that is already the binding constraint.
 *
 * The package is installed from a tarball rather than from the checkout, so a
 * cell measures what a user gets, and the store can name the version it ran.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CONTAINER_TOOLCHAIN = "/opt/pi-bench-tools";
export const CONTAINER_AGENT_DIR = "/opt/pi-bench-agent";
export const CONTAINER_PI = `${CONTAINER_TOOLCHAIN}/node_modules/.bin/pi`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Install Pi and the package into a host directory, once per harness run.
 * `packageSpec` is an npm spec: a published version for a real measurement, a
 * `.tgz` path when testing an unreleased build. Which one it was is recorded
 * with every cell, because a task run under a different package version is a
 * different measurement.
 */
export async function prepareToolchain({
  dir,
  piSpec,
  packageSpec,
  install = (cwd, specs) =>
    run("npm", ["install", "--no-audit", "--no-fund", ...specs], { cwd }),
}) {
  await mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, "package.json"))) {
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "pi-bench-toolchain", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
  }
  const result = await install(dir, [piSpec, packageSpec]);
  if (result.code !== 0) {
    throw new Error(`toolchain install failed: ${result.stderr.slice(-600)}`);
  }
  const lock = JSON.parse(
    await readFile(path.join(dir, "package-lock.json"), "utf8"),
  );
  const versionOf = (name) => lock.packages?.[`node_modules/${name}`]?.version;
  return {
    dir,
    piVersion: versionOf("@earendil-works/pi-coding-agent"),
    packageVersion: versionOf("pi-worker-graph"),
    // Copied into each cell's agent directory rather than referenced, so one
    // cell cannot leave state behind for the next.
    packageTree: path.join(dir, "node_modules", "pi-worker-graph"),
  };
}

/** The provider and model the real agent directory is configured with. */
export async function readAgentSettings(from) {
  try {
    return JSON.parse(await readFile(path.join(from, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * The host a provider's requests go to, read from the catalogue the cell will
 * actually run under rather than hard-coded.
 *
 * Only providers that declare a `baseUrl` can be confined to one destination,
 * which is what `bench/egress.mjs` needs. A provider that declares none is not
 * guessed at: the caller is told, and chooses between naming the host and
 * running unconfined.
 */
export async function providerEndpointHost(agentDir, provider) {
  let models;
  try {
    models = JSON.parse(
      await readFile(path.join(agentDir, "models.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
  const baseUrl = models?.providers?.[provider]?.baseUrl;
  if (typeof baseUrl !== "string") return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Refuse an arm whose models the chosen provider does not serve.
 *
 * A bad model id surfaces at `set_model`, which is after the image has been
 * pulled and the container started -- minutes of work and ~14 GB of disk to
 * learn something the catalogue on disk already knew. The check is advisory in
 * one direction only: a provider the cache does not mention at all cannot be
 * judged, so it passes. A provider that is listed and does not carry the model
 * is refused, because then the cache is evidence rather than a gap.
 */
export async function assertModelsServed(agentDir, provider, models) {
  let store;
  try {
    store = JSON.parse(
      await readFile(path.join(agentDir, "models-store.json"), "utf8"),
    );
  } catch {
    return;
  }
  const served = store?.[provider]?.models;
  if (!Array.isArray(served)) return;
  const ids = new Set(served.map((m) => m?.id));
  const missing = models.filter((m) => !ids.has(m));
  if (missing.length > 0) {
    throw new Error(
      `provider "${provider}" does not serve ${missing.join(", ")}. ` +
        `Its catalogue in ${agentDir}/models-store.json lists ${ids.size} ` +
        "models; pick another provider or refresh the catalogue in Pi.",
    );
  }
}

/**
 * The throwaway agent directory a cell runs under: credentials, the model
 * catalogue, and -- for a `graph` arm -- the package itself. Discovered
 * extensions, skills, prompt templates and sessions are deliberately left
 * behind: a cell must measure the package under test, not whatever else the
 * development box has installed.
 *
 * Pi loads a package because `settings.json` names it and its tree is under
 * `<agentDir>/npm/node_modules`, not because a `node_modules` happens to be on
 * disk somewhere. A solo arm gets neither, which is what keeps the machinery
 * out of it -- there is no flag to forget.
 */
export async function makeAgentDirectory({
  from,
  workerGraphConfig,
  packageTree,
  packageVersion,
  provider,
  model,
}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-bench-agent-"));
  const carried = ["auth.json", "models-store.json", "models.json"];
  const present = new Set(await readdir(from));
  if (!present.has("auth.json")) {
    throw new Error(`no auth.json under ${from}; a cell cannot authenticate`);
  }
  for (const file of carried) {
    if (present.has(file)) {
      await writeFile(
        path.join(dir, file),
        await readFile(path.join(from, file)),
        { mode: 0o600 },
      );
    }
  }

  const machinery = workerGraphConfig !== undefined;
  if (machinery) {
    if (packageTree === undefined) {
      throw new Error("a graph arm needs the package tree to install");
    }
    await writeFile(
      path.join(dir, "worker-graph.json"),
      `${JSON.stringify(workerGraphConfig, null, 2)}\n`,
      { mode: 0o600 },
    );
    const npmDir = path.join(dir, "npm", "node_modules", "pi-worker-graph");
    await mkdir(path.dirname(npmDir), { recursive: true });
    await cp(packageTree, npmDir, { recursive: true });
    await writeFile(
      path.join(dir, "npm", "package.json"),
      `${JSON.stringify(
        {
          name: "pi-agent-packages",
          private: true,
          dependencies: { "pi-worker-graph": packageVersion ?? "*" },
        },
        null,
        2,
      )}\n`,
    );
  }

  // The session's starting model, so the arm is what it claims to be from the
  // first turn rather than after a correction. `set_model` still runs, because
  // a model the catalogue cannot serve has to fail loudly rather than leave
  // the cell on whatever the default was.
  await writeFile(
    path.join(dir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: provider,
        defaultModel: model,
        packages: machinery
          ? [`npm:pi-worker-graph@${packageVersion ?? "latest"}`]
          : [],
      },
      null,
      2,
    )}\n`,
  );

  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Put the prepared toolchain and agent directory inside a running container. */
export async function installInContainer(
  container,
  { toolchainDir, agentDir },
) {
  await container.exec(
    `mkdir -p ${CONTAINER_TOOLCHAIN} ${CONTAINER_AGENT_DIR}`,
  );
  await container.copyIn(`${toolchainDir}/.`, CONTAINER_TOOLCHAIN);
  await container.copyIn(`${agentDir}/.`, CONTAINER_AGENT_DIR);
  await container.exec(`chmod 700 ${CONTAINER_AGENT_DIR}`);
  const check = await container.exec(`${CONTAINER_PI} --version`, {
    timeoutMs: 120_000,
  });
  if (check.code !== 0) {
    throw new Error(
      `pi will not run in the container: ${check.stderr.slice(-400)}`,
    );
  }
  return check.stdout.trim();
}
