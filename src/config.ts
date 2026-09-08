import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { PiWorkerProfile } from "./pi-subprocess.js";
import { parsePiWorkerProfiles } from "./pi-subprocess.js";

export const WORKER_GRAPH_CONFIG_FILENAME = "worker-graph.json";
export const WORKER_GRAPH_DEFAULT_STATE_DIRECTORY = "worker-graph";
export const WORKER_GRAPH_CONFIG_MAX_BYTES = 64 * 1024;

const CONFIG_FIELDS = new Set(["schemaVersion", "stateRoot", "profiles"]);
const MAX_PATH_BYTES = 4 * 1024;

export type WorkerGraphConfigurationErrorCode =
  | "missing"
  | "too_large"
  | "malformed"
  | "invalid"
  | "unsafe_state_root";

const CONFIGURATION_DIAGNOSTICS: Readonly<
  Record<WorkerGraphConfigurationErrorCode, string>
> = Object.freeze({
  missing: "Worker graph configuration file was not found",
  too_large: "Worker graph configuration file exceeds its size limit",
  malformed: "Worker graph configuration file is not valid JSON",
  invalid: "Worker graph configuration is invalid",
  unsafe_state_root: "Worker graph state root must be outside the checkout",
});

export class WorkerGraphConfigurationError extends Error {
  readonly code: WorkerGraphConfigurationErrorCode;

  constructor(code: WorkerGraphConfigurationErrorCode) {
    super(CONFIGURATION_DIAGNOSTICS[code]);
    this.name = "WorkerGraphConfigurationError";
    this.code = code;
  }
}

export interface WorkerGraphConfiguration {
  readonly stateRoot: string;
  readonly profiles: Readonly<Record<string, PiWorkerProfile>>;
}

export interface LoadWorkerGraphConfigurationOptions {
  readonly agentDirectory: string;
  readonly workingDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function canonicalizeWithMissingTail(path: string): Promise<string> {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw new WorkerGraphConfigurationError("invalid");
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new WorkerGraphConfigurationError("invalid");
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function readBoundedConfiguration(path: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new WorkerGraphConfigurationError("missing");
    }
    throw new WorkerGraphConfigurationError("invalid");
  }

  try {
    const buffer = Buffer.alloc(WORKER_GRAPH_CONFIG_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > WORKER_GRAPH_CONFIG_MAX_BYTES) {
      throw new WorkerGraphConfigurationError("too_large");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch {
      throw new WorkerGraphConfigurationError("malformed");
    }
  } catch (error) {
    if (error instanceof WorkerGraphConfigurationError) throw error;
    throw new WorkerGraphConfigurationError("invalid");
  } finally {
    await handle.close();
  }
}

function parseConfiguration(
  value: unknown,
  agentDirectory: string,
): WorkerGraphConfiguration {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => !CONFIG_FIELDS.has(field)) ||
    value.schemaVersion !== 1
  ) {
    throw new WorkerGraphConfigurationError("invalid");
  }

  let profiles: Readonly<Record<string, PiWorkerProfile>>;
  try {
    profiles = parsePiWorkerProfiles(value.profiles);
  } catch {
    throw new WorkerGraphConfigurationError("invalid");
  }

  if (
    value.stateRoot !== undefined &&
    (typeof value.stateRoot !== "string" ||
      value.stateRoot.trim().length === 0 ||
      value.stateRoot !== value.stateRoot.trim() ||
      Buffer.byteLength(value.stateRoot) > MAX_PATH_BYTES ||
      hasControlCharacter(value.stateRoot))
  ) {
    throw new WorkerGraphConfigurationError("invalid");
  }

  const resolvedAgentDirectory = resolve(agentDirectory);
  const stateRoot = resolve(
    resolvedAgentDirectory,
    value.stateRoot ?? WORKER_GRAPH_DEFAULT_STATE_DIRECTORY,
  );
  if (dirname(stateRoot) === stateRoot) {
    throw new WorkerGraphConfigurationError("invalid");
  }
  return Object.freeze({ stateRoot, profiles });
}

export async function loadWorkerGraphConfiguration(
  options: LoadWorkerGraphConfigurationOptions,
): Promise<WorkerGraphConfiguration> {
  if (
    options.agentDirectory.trim().length === 0 ||
    options.workingDirectory.trim().length === 0
  ) {
    throw new WorkerGraphConfigurationError("invalid");
  }
  const path = join(
    resolve(options.agentDirectory),
    WORKER_GRAPH_CONFIG_FILENAME,
  );
  const text = await readBoundedConfiguration(path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkerGraphConfigurationError("malformed");
  }
  const configuration = parseConfiguration(value, options.agentDirectory);
  const [workingDirectory, stateRoot] = await Promise.all([
    canonicalizeWithMissingTail(options.workingDirectory),
    canonicalizeWithMissingTail(configuration.stateRoot),
  ]);
  if (isInside(workingDirectory, stateRoot)) {
    throw new WorkerGraphConfigurationError("unsafe_state_root");
  }
  return configuration;
}
