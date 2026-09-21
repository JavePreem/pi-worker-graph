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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CONTAINER_TOOLCHAIN = "/opt/pi-bench-tools";
export const CONTAINER_AGENT_DIR = "/opt/pi-bench-agent";

/**
 * The Node the toolchain carries, and the entry point it runs.
 *
 * Seven of the fifteen instance images probed ship Node 18 or 20, and Pi
 * 0.85.1 imports `globSync`, which needs 22: in those images Pi does not
 * start, so the cell is not attempted and the instance is lost. The toolchain
 * already carries Pi rather than taking it from the image, so it carries a
 * Node too.
 *
 * It is deliberately **not** put on PATH. The agent builds with the image's
 * own Bazel and Node, and those images were built against the Node they ship;
 * swapping it underneath the build would trade a startup failure for build
 * failures that look like task failures. Only Pi runs under the carried Node,
 * through the shim below, so a worker spawned as a bare `pi` gets it while
 * everything else in the container is untouched.
 */
export const CONTAINER_NODE = `${CONTAINER_TOOLCHAIN}/node/bin/node`;
export const CONTAINER_PI_ENTRY = `${CONTAINER_TOOLCHAIN}/node_modules/.bin/pi`;
export const CONTAINER_PI = "/usr/local/bin/pi";

/**
 * The Node the toolchain fetches. Pinned rather than tracking latest, because
 * a cell records what it ran under and two cells run under different Nodes is
 * two measurements. It is the floor the package's own `engines` declares.
 */
export const NODE_VERSION = "22.19.0";

/**
 * The PATH Pi runs under, and therefore the one its worker subprocesses
 * inherit.
 *
 * Pi is started with no shell at all (`docker exec -i ... ${CONTAINER_PI}`),
 * so nothing sources `/etc/profile` and the image's own `ENV PATH` is whatever
 * it happens to be. Naming it here makes the environment the workers get the
 * same thing this file checks, rather than two environments that agree by
 * luck; `/usr/local/bin` is first because that is where the link below goes.
 */
export const CONTAINER_PATH =
  "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

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
 * Put a Node of a known version in the toolchain, for Pi to run under inside
 * the container. Downloaded once per toolchain directory and reused, because
 * the directory outlives a cell.
 *
 * The official linux-x64 build, rather than the host's own binary: the host is
 * whatever the development box runs and the images are not, so copying a
 * binary out of one glibc into another is the kind of thing that works until
 * it does not.
 */
export async function ensureNode({
  dir,
  version = NODE_VERSION,
  fetchImpl = fetch,
  extract = (archive, into) =>
    run("tar", ["-xJf", archive, "-C", into, "--strip-components=1"]),
}) {
  const target = path.join(dir, "node");
  const stamp = path.join(target, ".version");
  if (existsSync(stamp) && (await readFile(stamp, "utf8")).trim() === version) {
    return version;
  }
  const name = `node-v${version}-linux-x64`;
  const base = `https://nodejs.org/dist/v${version}`;
  const response = await fetchImpl(`${base}/${name}.tar.xz`);
  if (!response.ok) {
    throw new Error(`fetching ${name}.tar.xz: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  // Checked against the release's own manifest before anything is unpacked.
  // This binary runs Pi inside every container, with the cell's credentials
  // in the same filesystem, so taking it on the strength of TLS alone is a
  // larger trust than this harness needs to make.
  const sums = await fetchImpl(`${base}/SHASUMS256.txt`);
  if (!sums.ok) {
    throw new Error(`fetching SHASUMS256.txt: ${sums.status}`);
  }
  const expected = /^(\w{64})\s+\S*?node-v[\d.]+-linux-x64\.tar\.xz$/m.exec(
    await sums.text(),
  )?.[1];
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected === undefined || expected !== actual) {
    throw new Error(
      `${name}.tar.xz does not match the release manifest: expected ` +
        `${expected ?? "no entry"}, got ${actual}`,
    );
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const archive = path.join(dir, `${name}.tar.xz`);
  await writeFile(archive, bytes);
  const extracted = await extract(archive, target);
  await rm(archive, { force: true });
  if (extracted?.code !== undefined && extracted.code !== 0) {
    throw new Error(`unpacking ${name}: ${extracted.stderr?.slice(-300)}`);
  }
  await writeFile(stamp, `${version}\n`);
  return version;
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
  // Injected for the same reason `install` is: an automated test reaches no
  // network, and a 40 MB download in a unit test is a test of nodejs.org.
  ensure = ensureNode,
}) {
  await mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, "package.json"))) {
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "pi-bench-toolchain", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
  }
  const nodeVersion = await ensure({ dir });
  const result = await install(dir, [piSpec, packageSpec]);
  if (result.code !== 0) {
    throw new Error(`toolchain install failed: ${result.stderr.slice(-600)}`);
  }
  const lock = JSON.parse(
    await readFile(path.join(dir, "package-lock.json"), "utf8"),
  );
  const versionOf = (name) => lock.packages?.[`node_modules/${name}`]?.version;
  // The tree is `docker cp`'d into every container, where it is owned by a
  // uid nothing runs as. Same reason as the agent directory below, and the
  // failure is worse: an unreadable `pi` kills the cell before it starts.
  await widenToForeignUid(dir);
  return {
    dir,
    nodeVersion,
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

  await widenToForeignUid(dir);
  // The one mode that has to be narrow, and the one `mkdtemp` already gives.
  // Set again so the invariant holds by construction rather than by trust.
  await chmod(dir, 0o700);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Make everything under a copied-in directory usable by a uid that does not own
 * it, which sounds wrong for credentials and is not.
 *
 * `docker cp` preserves the host UID, and the container runs as root with
 * every capability dropped -- including CAP_DAC_OVERRIDE, the one that lets
 * root ignore file permissions, and CAP_CHOWN, the one that would let it take
 * ownership instead. A mode of 0600 owned by the host user is therefore
 * unreadable *by Pi itself*, which surfaces as "Model not found" and an
 * unauthenticated session rather than as a permission error. What restricts
 * access is the directory: 0700 here, and 0700 again in the container once the
 * copy has landed. The modes inside only have to let the process that needs
 * them in.
 *
 * Write, not just read, because Pi writes back into its own agent directory: a
 * catalogue refresh rewrites `models-store.json`, and an OAuth arm rewrites
 * `auth.json` when the token is refreshed. Left at 0644 those rewrites fail
 * with EACCES, and the arm dies in the same quiet way. Executability is
 * carried across rather than granted, because the toolchain tree's `.bin`
 * entries have to stay runnable and nothing else has any business being so.
 *
 * Symlinks are left alone: a mode on a symlink means nothing on Linux and
 * `chmod` would follow it, possibly out of the tree. The entries a
 * `node_modules/.bin` points at are inside the tree and are reached by walking
 * it.
 *
 * Done as a pass at the end rather than as a mode on each write, because a
 * mode handed to `writeFile` or `mkdir` is masked by the process umask: under
 * `umask 077` the files come out 0600 however they were asked for, and the
 * failure that follows is the silent one above. `cp` and `npm install`
 * likewise carry their own modes across. `chmod` ignores the umask.
 */
async function widenToForeignUid(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await chmod(full, 0o777);
      await widenToForeignUid(full);
    } else if (entry.isFile()) {
      const { mode } = await stat(full);
      await chmod(full, mode & 0o111 ? 0o777 : 0o666);
    }
  }
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

  // `pi` has to be on PATH, or a `graph` arm spawns no workers.
  //
  // The package identifies Pi positively, by resolving Pi's package from its
  // own location (`src/pi-subprocess.ts`). Here it cannot: Pi is installed in
  // one tree and the package in another, because Pi loads a package from the
  // agent directory's npm tree and that is where a real install puts it. The
  // resolution therefore falls through to spawning a bare `pi`, and the
  // image's PATH does not carry this toolchain. Every worker then fails to
  // start, the orchestrator is told only that, and the cell records the arm
  // as having failed the task.
  //
  // A real install does not have this gap -- Pi is either a bundled binary,
  // which the package recognises, or an npm install that is already on PATH.
  // The link is what makes the container resemble that rather than a defect
  // being worked around.
  // A shim rather than a symlink, so the carried Node is used for Pi and for
  // nothing else. `#!/usr/bin/env node` in Pi's own entry would otherwise pick
  // up whatever the image ships, which on seven of the images probed is too
  // old to run it at all.
  await container.exec(
    `printf '#!/bin/sh\\nexec ${CONTAINER_NODE} ${CONTAINER_PI_ENTRY} "$@"\\n' > ${CONTAINER_PI} && chmod 755 ${CONTAINER_PI}`,
  );

  // Run it before asking whether it is on PATH, so a toolchain that did not
  // survive the copy is named as what it is: the shim resolves through the
  // same tree, so a missing Node or an unexecutable `pi` would otherwise
  // surface as a PATH problem and be reported as the wrong fault.
  const check = await container.exec(
    `env -i PATH=${CONTAINER_PATH} ${CONTAINER_PI} --version`,
    { timeoutMs: 120_000 },
  );
  if (check.code !== 0) {
    throw new Error(
      `pi will not run in the container: ${check.stderr.slice(-400)}`,
    );
  }

  // Checked under the PATH Pi is actually started with, not the shell's.
  // `container.exec` runs `bash -lc`, and a login shell sources
  // `/etc/profile`, which sets a PATH of its own; Pi is started with no shell
  // and hands its own environment to every worker it spawns. Verifying the
  // login shell's PATH would pass on an image whose workers still find no
  // `pi`, which is the one failure this check exists to make impossible.
  const onPath = await container.exec(
    `env -i PATH=${CONTAINER_PATH} sh -c 'command -v pi'`,
  );
  if (onPath.code !== 0) {
    throw new Error(
      "pi is not on PATH in the container; a graph arm would spawn no workers",
    );
  }
  return check.stdout.trim();
}
