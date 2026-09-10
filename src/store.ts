import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { GraphState, NodeStatus, NormalizedGraph } from "./graph.js";
import { normalizeGraph, setNodeStatus, settleBlocked } from "./graph.js";
import type { JsonValue } from "./json.js";
import { isJsonValue, isRecord } from "./json.js";
import type { NodeOutput } from "./output.js";
import {
  NODE_OUTPUT_LIMITS,
  parseNodeArtifact,
  parseNodeDiagnostics,
  parseNodeOutput,
} from "./output.js";
import type { TaskUsage } from "./usage.js";
import { parseTaskUsage } from "./usage.js";

export type { JsonValue } from "./json.js";

export const RUN_STORE_MAX_RECORD_BYTES = 1024 * 1024;
export const RUN_STORE_DEFAULT_MAX_RUNS = 64;
export const RUN_STORE_MAX_RUNS = 256;
export const RUN_COORDINATION_MAX_TEXT_BYTES = 16 * 1024;
/** Bound for one path or symbol, matching the report path bound. */
export const RUN_COORDINATION_MAX_ITEM_BYTES = 4 * 1024;
export const RUN_COORDINATION_MAX_ITEMS = 16;
/** Retained coordination records per run. */
export const RUN_COORDINATION_MAX_RECORDS = 256;
/** Bound for one requested coordination page. */
export const RUN_COORDINATION_MAX_READ = 256;
/**
 * Serialized bound for one coordination record, checked when a record is
 * published and again when it is read, so the field bounds above cannot
 * combine into a record that alone exceeds a page.
 */
export const RUN_COORDINATION_MAX_RECORD_BYTES = 32 * 1024;
/**
 * Serialized bound for one returned coordination page. A page stops before the
 * first record that would exceed it and reports a cursor, and no single record
 * can reach it, so a returned page never exceeds this.
 */
export const RUN_COORDINATION_MAX_PAGE_BYTES = 64 * 1024;
/**
 * Length of a coordination record identifier, which is also a read cursor.
 * Identifiers are fixed-width so that sorting them sorts the sequence, and the
 * child tool schemas bound their cursor parameter with this.
 */
export const RUN_COORDINATION_ID_LENGTH = 6;

const MUTATION_LOCK_WAIT_MS = 250;
const MUTATION_LOCK_POLL_MS = 5;

const SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_SLOT_DIRECTORY = "slots";
const RUN_SLOT_RECORD = "slot.json";
const RUN_SLOT_PATTERN = /^(0|[1-9][0-9]*)\.json$/;
const RUN_MUTATION_LOCK = "mutation.lock";
const RUN_COORDINATION_DIRECTORY = "coordination";
const RUN_ARTIFACT_DIRECTORY = "artifacts";
const RECORD_SUFFIX = ".json";
const COORDINATION_ID_PATTERN = new RegExp(
  `^[0-9]{${RUN_COORDINATION_ID_LENGTH}}$`,
);
const MAX_COORDINATION_SEQUENCE = 10 ** RUN_COORDINATION_ID_LENGTH - 1;
const COORDINATION_PUBLISH_ATTEMPTS = 16;
const TASK_KEY_PATTERN =
  /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NODE_STATUSES = new Set<NodeStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "blocked",
]);
const OUTPUT_STATUSES = new Set<NodeOutputStatus>([
  "succeeded",
  "failed",
  "aborted",
]);
const NODE_OUTPUT_RECORD_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "taskId",
  "taskKey",
  "attempt",
  "status",
  "completedAt",
  "output",
  "artifact",
  "usage",
  "diagnostics",
]);
const NODE_ARTIFACT_RECORD_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "taskId",
  "taskKey",
  "attempt",
  "publishedAt",
  "text",
]);
const RUN_OWNER_RECORD_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "ownerId",
  "acquiredAt",
]);
const RUN_MUTATION_LOCK_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "taskId",
]);
const RUN_EVENT_RECORD_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "eventId",
  "runId",
  "taskId",
  "eventKind",
  "timestamp",
  "message",
  "paths",
  "symbols",
  "recipients",
]);
const RUN_MESSAGE_RECORD_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "messageId",
  "runId",
  "senderTaskId",
  "recipientTaskId",
  "timestamp",
  "message",
]);
const RUN_EVENT_KINDS = new Set<RunEventKind>([
  "decision",
  "interface",
  "risk",
  "conflict",
  "handoff",
  "progress",
]);

interface SlotClaim {
  readonly index: number;
  readonly owner?: string;
}

export type RunStoreErrorCode =
  | "invalid_argument"
  | "invalid_identifier"
  | "unknown_task"
  | "not_found"
  | "record_exists"
  | "record_too_large"
  | "malformed_record"
  | "invalid_record"
  | "retention_limit"
  | "locked"
  | "ownership";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;
  readonly recordPath: string | undefined;

  constructor(code: RunStoreErrorCode, message: string, recordPath?: string) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
    this.recordPath = recordPath;
  }
}

export interface RunManifestTask {
  readonly id: string;
  readonly key: string;
  readonly needs: readonly string[];
  readonly payload?: JsonValue;
}

export interface RunManifest {
  readonly schemaVersion: 1;
  readonly kind: "run-manifest";
  readonly runId: string;
  readonly createdAt: string;
  readonly graph: {
    readonly tasks: readonly RunManifestTask[];
    readonly concurrency?: number;
  };
}

/**
 * One unit of retained capacity, as `listRetainedRuns` reports it.
 *
 * A healthy run has both a directory and a slot. The two can disagree, and the
 * listing names those cases rather than hiding them: a slot with no run
 * directory is capacity an interrupted creation stranded, and a run directory
 * with no slot is the disagreement that stops the store admitting any work at
 * all. `deleteRun` resolves either by name.
 */
export interface RetainedRun {
  /** Absent only for a slot whose record names no readable run. */
  readonly runId?: string;
  /** Absent when a published run holds no capacity slot. */
  readonly slot?: number;
  /** Absent when no run directory was published, or none can be read. */
  readonly createdAt?: string;
  /** An orchestrator holds this run, so `deleteRun` refuses to remove it. */
  readonly owned: boolean;
}

/**
 * Exclusive ownership of one run's mutable lifecycle.
 *
 * The owner ID is an opaque capability held by the process that acquired the
 * run. Ownership is deliberately fail-closed: an owner record left by a
 * crashed process is not reclaimed by elapsed time or by inspecting a PID.
 */
export interface RunOwnership {
  readonly runId: string;
  readonly ownerId: string;
}

export type RunEventKind =
  | "decision"
  | "interface"
  | "risk"
  | "conflict"
  | "handoff"
  | "progress";

export interface RunEventRecord {
  readonly schemaVersion: 1;
  readonly kind: "run-event";
  readonly eventId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly eventKind: RunEventKind;
  readonly timestamp: string;
  readonly message: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly recipients?: readonly string[];
}

export interface PublishRunEvent {
  readonly taskId: string;
  readonly eventKind: RunEventKind;
  readonly message: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly recipients?: readonly string[];
}

export interface RunEventQuery {
  readonly cursor?: string;
  readonly eventKind?: RunEventKind;
  readonly recipient?: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly limit?: number;
}

export interface RunEventQueryResult {
  readonly events: readonly RunEventRecord[];
  readonly nextCursor?: string;
}

export interface RunMessageRecord {
  readonly schemaVersion: 1;
  readonly kind: "run-message";
  readonly messageId: string;
  readonly runId: string;
  readonly senderTaskId: string;
  readonly recipientTaskId: string;
  readonly timestamp: string;
  readonly message: string;
}

export interface PublishRunMessage {
  readonly senderTaskId: string;
  readonly recipientTaskId: string;
  readonly message: string;
}

export interface RunMessageQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RunMessageQueryResult {
  readonly messages: readonly RunMessageRecord[];
  readonly nextCursor?: string;
}

export interface NodeStateRecord {
  readonly schemaVersion: 1;
  readonly kind: "node-state";
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly attempt: number;
  readonly status: NodeStatus;
  readonly updatedAt: string;
}

export type NodeOutputStatus = "succeeded" | "failed" | "aborted";

/**
 * A retained text artifact is worker-authored long-form text that does not
 * belong in the structured report: it is not propagated over dependency edges
 * and is never parsed, only retained under the run for later review. One
 * artifact belongs to one task attempt, is published under the same mutation
 * lock as that attempt's output, and is removed with its run.
 *
 * `NODE_OUTPUT_LIMITS.maxArtifactBytes` bounds the text. JSON escaping can
 * expand one byte sixfold, so that bound stays far enough beneath
 * `RUN_STORE_MAX_RECORD_BYTES` that no text it admits can produce a record
 * the store would then refuse to write or read back.
 */
export interface NodeArtifactRecord {
  readonly schemaVersion: 1;
  readonly kind: "node-artifact";
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly attempt: number;
  readonly publishedAt: string;
  readonly text: string;
}

/**
 * Recorded in the output envelope so a reader learns that an artifact exists,
 * and how large it is, without reading the artifact itself.
 */
export interface NodeArtifactReference {
  readonly bytes: number;
}

interface NodeOutputRecordBase {
  readonly schemaVersion: 1;
  readonly kind: "node-output";
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly attempt: number;
  readonly completedAt: string;
  readonly artifact?: NodeArtifactReference;
  /**
   * What the attempt spent, when the executor accounted for it. Recorded for
   * every terminal status, including aborted: an attempt the run stopped had
   * still spent what it spent by then.
   */
  readonly usage?: TaskUsage;
  readonly diagnostics?: string;
}

export type NodeOutputRecord = NodeOutputRecordBase &
  (
    | {
        readonly status: "succeeded";
        readonly output: NodeOutput;
      }
    | {
        readonly status: "failed";
        readonly output?: NodeOutput;
      }
    | {
        readonly status: "aborted";
        readonly output?: never;
      }
  );

export type PublishNodeOutput =
  | {
      readonly taskId: string;
      readonly status: "succeeded";
      readonly output: NodeOutput;
      /** Retained verbatim beside the report; never propagated downstream. */
      readonly artifact?: string;
      readonly usage?: TaskUsage;
      readonly diagnostics?: string;
    }
  | {
      readonly taskId: string;
      readonly status: "failed";
      readonly output?: NodeOutput;
      readonly artifact?: string;
      readonly usage?: TaskUsage;
      readonly diagnostics?: string;
    }
  | {
      readonly taskId: string;
      readonly status: "aborted";
      readonly output?: never;
      readonly artifact?: never;
      readonly usage?: TaskUsage;
      readonly diagnostics?: string;
    };

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function stateRootPath(stateRoot: string): string {
  if (stateRoot.trim().length === 0) {
    throw new RunStoreError(
      "invalid_argument",
      "The run store state root must not be empty",
    );
  }
  const root = resolve(stateRoot);
  if (dirname(root) === root) {
    throw new RunStoreError(
      "invalid_argument",
      "The run store state root must not be the filesystem root",
    );
  }
  return root;
}

async function publishedRunIds(runs: string): Promise<ReadonlySet<string>> {
  const entries = await readdir(runs, { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  );
}

async function slotOwner(path: string): Promise<string | undefined> {
  try {
    const record = await readJson(path);
    if (!isRecord(record) || typeof record.runId !== "string") return undefined;
    // The recorded owner is compared against directory names, so it must be a
    // run ID and not a traversal written into the slot by anything else.
    return RUN_ID_PATTERN.test(record.runId) ? record.runId : undefined;
  } catch {
    return undefined;
  }
}

async function readSlotClaims(slots: string): Promise<readonly SlotClaim[]> {
  let entries: readonly import("node:fs").Dirent<string>[];
  try {
    entries = await readdir(slots, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    // No directory is no claims. A creator makes it before reading, so this
    // is only reached by a reader looking at a store that holds no capacity.
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && RUN_SLOT_PATTERN.test(entry.name))
      .map(async (entry) => {
        const index = Number.parseInt(entry.name, 10);
        const owner = await slotOwner(join(slots, entry.name));
        return owner === undefined ? { index } : { index, owner };
      }),
  );
}

/**
 * Capacity is a fixed set of atomically claimed slot files, so the limit is
 * structural rather than counted: at most `maximumRuns` slots can exist, so at
 * most `maximumRuns` runs can publish. Concurrent creators are arbitrated by
 * the filesystem — the lowest index whose link succeeds is that creator's — so
 * an available slot is always claimed by exactly one of them rather than
 * refused to all of them.
 *
 * Runs are read before slots. A creator links its slot before renaming its run
 * into place, so every published run's slot is visible here and an in-flight
 * creation can never be mistaken for a missing one. A published run that is
 * genuinely unaccounted for means the two disagree, and the store then admits
 * nobody rather than letting each creator claim the same free capacity.
 *
 * The structure only bounds what it can see: a run holding a slot at or above
 * the current limit occupies none of the indices a claim searches, so lowering
 * the limit below an assigned index would leave that run's capacity claimable
 * a second time. Such a run is treated the same way as a missing slot — the
 * store admits nobody until the numbering is reconciled.
 */
async function claimRunSlot(
  runs: string,
  runId: string,
  maximumRuns: number,
): Promise<string> {
  const slots = join(runs, RUN_SLOT_DIRECTORY);
  await mkdir(slots, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(slots, DIRECTORY_MODE);
  const published = await publishedRunIds(runs);
  const claims = await readSlotClaims(slots);
  const owners = new Set(claims.flatMap((claim) => claim.owner ?? []));
  const bounded = new Set(
    claims.flatMap((claim) =>
      claim.index < maximumRuns ? (claim.owner ?? []) : [],
    ),
  );
  const beyondLimit = [...published].filter(
    (id) => owners.has(id) && !bounded.has(id),
  ).length;
  if (beyondLimit > 0) {
    throw new RunStoreError(
      "retention_limit",
      `${beyondLimit} published run(s) hold a capacity slot at or above the current maximum of ${maximumRuns}; the run store admits no new work until the slot files in ${JSON.stringify(slots)} are renumbered below that maximum`,
      slots,
    );
  }
  const unaccounted = [...published].filter((id) => !owners.has(id)).length;
  if (unaccounted > 0) {
    throw new RunStoreError(
      "retention_limit",
      `${unaccounted} published run(s) have no capacity slot; the run store admits no new work until the run directories in ${JSON.stringify(runs)} and their slots agree`,
      slots,
    );
  }
  if (published.size >= maximumRuns) {
    throw new RunStoreError(
      "retention_limit",
      `The run store retains ${published.size} of at most ${maximumRuns} runs; remove old run state before starting another graph`,
      runs,
    );
  }
  const claimed = await linkFirstFreeSlot(slots, runId, maximumRuns);
  if (claimed !== undefined) return claimed;
  const reclaimable = claims.filter(
    (claim) =>
      claim.index < maximumRuns &&
      (claim.owner === undefined || !published.has(claim.owner)),
  ).length;
  throw new RunStoreError(
    "retention_limit",
    `All ${maximumRuns} run capacity slots are claimed; ${reclaimable} of them belong to runs that were never published and can be deleted from ${JSON.stringify(slots)}`,
    slots,
  );
}

/**
 * The claim is a hard link to a record that is already complete on disk, so a
 * crash can never leave a slot that holds capacity without naming its owner.
 */
async function linkFirstFreeSlot(
  slots: string,
  runId: string,
  maximumRuns: number,
): Promise<string | undefined> {
  const temporaryPath = await writeTemporaryFile(join(slots, RUN_SLOT_RECORD), {
    schemaVersion: SCHEMA_VERSION,
    kind: "run-slot",
    runId,
  });
  try {
    for (let index = 0; index < maximumRuns; index += 1) {
      const path = join(slots, `${index}.json`);
      try {
        await link(temporaryPath, path);
        return path;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return undefined;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function releaseRunSlot(path: string, runId: string): Promise<void> {
  if ((await slotOwner(path)) !== runId) return;
  await rm(path, { force: true });
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunStoreError(
      "invalid_identifier",
      `Invalid run ID ${JSON.stringify(runId)}`,
    );
  }
}

function runsPath(stateRoot: string): string {
  return join(stateRootPath(stateRoot), "runs");
}

function runPath(stateRoot: string, runId: string): string {
  assertRunId(runId);
  return join(runsPath(stateRoot), runId);
}

function ownerPath(stateRoot: string, runId: string): string {
  return join(runPath(stateRoot, runId), "owner.json");
}

/**
 * Events and messages of a run share one journal directory, so a single
 * exclusive create both claims a record's sequence number and stores the
 * record. The directory is created with the run, so publishing is only ever
 * one atomic link into an existing directory.
 */
function coordinationDirectory(stateRoot: string, runId: string): string {
  return join(runPath(stateRoot, runId), RUN_COORDINATION_DIRECTORY);
}

function recordId(fileName: string): string {
  return fileName.slice(0, -RECORD_SUFFIX.length);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function serializedRecord(value: unknown, recordPath?: string): string {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch {
    throw new RunStoreError(
      "invalid_record",
      "Record is not JSON serializable",
      recordPath,
    );
  }
  if (Buffer.byteLength(serialized) > RUN_STORE_MAX_RECORD_BYTES) {
    throw new RunStoreError(
      "record_too_large",
      `Record exceeds the ${RUN_STORE_MAX_RECORD_BYTES} byte limit`,
      recordPath,
    );
  }
  return serialized;
}

/**
 * `durable` flushes the record before it is linked into place, which is what
 * every stored record needs. The mutation lock is the exception: it is not
 * state to recover, and flushing it would only lengthen the critical section
 * that the orchestrator and its workers contend for.
 */
async function writeNewFile(
  path: string,
  value: unknown,
  durable = true,
): Promise<void> {
  const contents = serializedRecord(value, path);
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTemporaryFile(
  finalPath: string,
  value: unknown,
  durable = true,
): Promise<string> {
  const temporaryPath = join(
    dirname(finalPath),
    `.${basename(finalPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeNewFile(temporaryPath, value, durable);
    return temporaryPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function replaceRecord(path: string, value: unknown): Promise<void> {
  const temporaryPath = await writeTemporaryFile(path, value);
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function publishRecord(
  path: string,
  value: unknown,
  durable = true,
): Promise<void> {
  const temporaryPath = await writeTemporaryFile(path, value, durable);
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new RunStoreError(
        "record_exists",
        `Immutable record already exists at ${JSON.stringify(path)}`,
        path,
      );
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readJson(path: string): Promise<unknown> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new RunStoreError(
        "not_found",
        `Record not found at ${JSON.stringify(path)}`,
        path,
      );
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (metadata.size > RUN_STORE_MAX_RECORD_BYTES) {
      throw new RunStoreError(
        "record_too_large",
        `Record exceeds the ${RUN_STORE_MAX_RECORD_BYTES} byte limit`,
        path,
      );
    }

    const buffer = Buffer.alloc(RUN_STORE_MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length <= RUN_STORE_MAX_RECORD_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > RUN_STORE_MAX_RECORD_BYTES) {
      throw new RunStoreError(
        "record_too_large",
        `Record exceeds the ${RUN_STORE_MAX_RECORD_BYTES} byte limit`,
        path,
      );
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
      return JSON.parse(text);
    } catch {
      throw new RunStoreError(
        "malformed_record",
        `Record at ${JSON.stringify(path)} is not valid UTF-8 JSON`,
        path,
      );
    }
  } finally {
    await handle.close();
  }
}

function invalidRecord(path: string, detail: string): never {
  throw new RunStoreError(
    "invalid_record",
    `Invalid record at ${JSON.stringify(path)}: ${detail}`,
    path,
  );
}

function validateRunOwnership(value: unknown, path: string): RunOwnership {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "run-owner" ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    typeof value.ownerId !== "string" ||
    !RUN_ID_PATTERN.test(value.ownerId) ||
    !isTimestamp(value.acquiredAt) ||
    Object.keys(value).some((field) => !RUN_OWNER_RECORD_FIELDS.has(field))
  ) {
    return invalidRecord(path, "run ownership does not match schema version 1");
  }
  return { runId: value.runId, ownerId: value.ownerId };
}

/**
 * The run mutation lock, which names the holder that took it.
 *
 * The orchestrator and every worker of a run contend for one lock, and to a
 * waiter a lock held by a live publisher is indistinguishable from one left by
 * a process that was killed while holding it. Naming the holder lets the graph
 * runner tell the two apart: it recovers a lock whose named task it knows has
 * finished, and waits out anything else. `taskId` is absent when the
 * orchestrator holds the lock for one of its own mutations.
 */
interface RunMutationLockRecord {
  readonly schemaVersion: 1;
  readonly kind: "run-mutation-lock";
  readonly runId: string;
  readonly taskId?: string;
}

function validateRunMutationLock(
  value: unknown,
  path: string,
): RunMutationLockRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "run-mutation-lock" ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    (value.taskId !== undefined && typeof value.taskId !== "string") ||
    Object.keys(value).some((field) => !RUN_MUTATION_LOCK_FIELDS.has(field))
  ) {
    return invalidRecord(
      path,
      "run mutation lock does not match schema version 1",
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "run-mutation-lock",
    runId: value.runId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
  };
}

function parseOwnershipCapability(value: unknown): RunOwnership {
  try {
    if (!isRecord(value)) throw new Error("invalid ownership capability");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid ownership capability");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "runId" && key !== "ownerId")
    ) {
      throw new Error("invalid ownership capability");
    }
    const runIdDescriptor = Object.getOwnPropertyDescriptor(value, "runId");
    const ownerIdDescriptor = Object.getOwnPropertyDescriptor(value, "ownerId");
    if (
      runIdDescriptor === undefined ||
      !runIdDescriptor.enumerable ||
      !("value" in runIdDescriptor) ||
      ownerIdDescriptor === undefined ||
      !ownerIdDescriptor.enumerable ||
      !("value" in ownerIdDescriptor) ||
      typeof runIdDescriptor.value !== "string" ||
      !RUN_ID_PATTERN.test(runIdDescriptor.value) ||
      typeof ownerIdDescriptor.value !== "string" ||
      !RUN_ID_PATTERN.test(ownerIdDescriptor.value)
    ) {
      throw new Error("invalid ownership capability");
    }
    return Object.freeze({
      runId: runIdDescriptor.value,
      ownerId: ownerIdDescriptor.value,
    });
  } catch {
    throw new RunStoreError("ownership", "Run ownership capability is invalid");
  }
}

/**
 * Takes the run mutation lock, naming `taskId` as its holder when a worker
 * publication takes it rather than the orchestrator.
 *
 * The lock is claimed by hard-linking a record that is already complete on
 * disk, so the lock never exists without naming who holds it and a waiter
 * always has something to attribute contention to. Waiting out the deadline
 * fails with `locked`, which is contention and not an ownership conflict: only
 * a caller that can show the named holder has finished may recover the lock.
 */
async function acquireRunMutationLock(
  stateRoot: string,
  runId: string,
  taskId?: string,
): Promise<() => Promise<void>> {
  const path = join(runPath(stateRoot, runId), RUN_MUTATION_LOCK);
  const record: RunMutationLockRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: "run-mutation-lock",
    runId,
    ...(taskId === undefined ? {} : { taskId }),
  };
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
  for (;;) {
    try {
      await publishRecord(path, record, false);
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "record_exists") {
        if (Date.now() >= deadline) {
          throw new RunStoreError(
            "locked",
            `Run ${JSON.stringify(runId)} has a mutation in flight`,
            path,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, MUTATION_LOCK_POLL_MS),
        );
        continue;
      }
      if (errorCode(error) === "ENOENT") {
        throw new RunStoreError(
          "not_found",
          `Run ${JSON.stringify(runId)} was not found`,
          path,
        );
      }
      throw error;
    }
  }
}

async function assertRunOwnership(
  stateRoot: string,
  runId: string,
  ownership: unknown,
): Promise<() => Promise<void>> {
  const capability = parseOwnershipCapability(ownership);
  const path = ownerPath(stateRoot, runId);
  const releaseMutationLock = await acquireRunMutationLock(stateRoot, runId);
  try {
    if (capability.runId !== runId) {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is owned by another orchestrator`,
        path,
      );
    }
    const record = validateRunOwnership(await readJson(path), path);
    if (record.runId !== runId || record.ownerId !== capability.ownerId) {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is owned by another orchestrator`,
        path,
      );
    }
    return releaseMutationLock;
  } catch (error) {
    await releaseMutationLock();
    if (error instanceof RunStoreError && error.code === "not_found") {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is not owned by an orchestrator`,
        path,
      );
    }
    throw error;
  }
}

function validStringArray(
  value: unknown,
  maximumItemBytes: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= RUN_COORDINATION_MAX_ITEMS &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        Buffer.byteLength(item) <= maximumItemBytes,
    )
  );
}

function validateRunEvent(value: unknown, path: string): RunEventRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "run-event" ||
    typeof value.eventId !== "string" ||
    !COORDINATION_ID_PATTERN.test(value.eventId) ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    Buffer.byteLength(value.taskId) > RUN_COORDINATION_MAX_TEXT_BYTES ||
    typeof value.eventKind !== "string" ||
    !RUN_EVENT_KINDS.has(value.eventKind as RunEventKind) ||
    !isTimestamp(value.timestamp) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    Buffer.byteLength(value.message) > RUN_COORDINATION_MAX_TEXT_BYTES ||
    (value.paths !== undefined &&
      !validStringArray(value.paths, RUN_COORDINATION_MAX_ITEM_BYTES)) ||
    (value.symbols !== undefined &&
      !validStringArray(value.symbols, RUN_COORDINATION_MAX_ITEM_BYTES)) ||
    (value.recipients !== undefined &&
      !validStringArray(value.recipients, RUN_COORDINATION_MAX_TEXT_BYTES)) ||
    Object.keys(value).some((field) => !RUN_EVENT_RECORD_FIELDS.has(field))
  ) {
    return invalidRecord(path, "run event does not match schema version 1");
  }
  return value as unknown as RunEventRecord;
}

function validateRunMessage(value: unknown, path: string): RunMessageRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "run-message" ||
    typeof value.messageId !== "string" ||
    !COORDINATION_ID_PATTERN.test(value.messageId) ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    typeof value.senderTaskId !== "string" ||
    value.senderTaskId.length === 0 ||
    Buffer.byteLength(value.senderTaskId) > RUN_COORDINATION_MAX_TEXT_BYTES ||
    typeof value.recipientTaskId !== "string" ||
    value.recipientTaskId.length === 0 ||
    Buffer.byteLength(value.recipientTaskId) >
      RUN_COORDINATION_MAX_TEXT_BYTES ||
    !isTimestamp(value.timestamp) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    Buffer.byteLength(value.message) > RUN_COORDINATION_MAX_TEXT_BYTES ||
    Object.keys(value).some((field) => !RUN_MESSAGE_RECORD_FIELDS.has(field))
  ) {
    return invalidRecord(path, "run message does not match schema version 1");
  }
  return value as unknown as RunMessageRecord;
}

function coordinationText(
  value: unknown,
  field: string,
  maximumBytes = RUN_COORDINATION_MAX_TEXT_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw new RunStoreError(
      "invalid_argument",
      `Coordination ${field} is invalid or oversized`,
    );
  }
  return value;
}

function coordinationList(
  value: unknown,
  field: string,
  maximumItemBytes: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!validStringArray(value, maximumItemBytes)) {
    throw new RunStoreError(
      "invalid_argument",
      `Coordination ${field} is invalid or oversized`,
    );
  }
  return Object.freeze([...value]);
}

function coordinationLimit(value: unknown): number {
  if (value === undefined) return RUN_COORDINATION_MAX_READ;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > RUN_COORDINATION_MAX_READ
  ) {
    throw new RunStoreError(
      "invalid_argument",
      "Coordination read limit is invalid",
    );
  }
  return value;
}

function coordinationCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !COORDINATION_ID_PATTERN.test(value)) {
    throw new RunStoreError(
      "invalid_argument",
      "Coordination cursor is invalid",
    );
  }
  return value;
}

function validateManifest(value: unknown, path: string): RunManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "run-manifest" ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !isTimestamp(value.createdAt) ||
    !isRecord(value.graph) ||
    !Array.isArray(value.graph.tasks)
  ) {
    return invalidRecord(
      path,
      "manifest envelope does not match schema version 1",
    );
  }

  const tasks: RunManifestTask[] = [];
  const taskKeys = new Set<string>();
  for (const candidate of value.graph.tasks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.key !== "string" ||
      !TASK_KEY_PATTERN.test(candidate.key) ||
      !Array.isArray(candidate.needs) ||
      !candidate.needs.every((dependency) => typeof dependency === "string") ||
      ("payload" in candidate && !isJsonValue(candidate.payload))
    ) {
      return invalidRecord(path, "manifest contains an invalid task");
    }
    if (taskKeys.has(candidate.key)) {
      return invalidRecord(
        path,
        "manifest contains duplicate task storage keys",
      );
    }
    taskKeys.add(candidate.key);
    tasks.push(candidate as unknown as RunManifestTask);
  }

  const concurrency = value.graph.concurrency;
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || (concurrency as number) <= 0)
  ) {
    return invalidRecord(path, "manifest contains invalid concurrency");
  }

  try {
    const normalized = normalizeGraph({
      tasks: tasks.map((task) => ({
        id: task.id,
        needs: task.needs,
        ...(task.payload === undefined ? {} : { payload: task.payload }),
      })),
      ...(concurrency === undefined
        ? {}
        : { concurrency: concurrency as number }),
    });
    for (const [index, task] of tasks.entries()) {
      const normalizedTask = normalized.tasks[index];
      if (
        normalizedTask?.id !== task.id ||
        JSON.stringify(normalizedTask.needs) !== JSON.stringify(task.needs)
      ) {
        return invalidRecord(path, "manifest graph is not normalized");
      }
    }
  } catch {
    return invalidRecord(path, "manifest contains an invalid graph");
  }

  return value as unknown as RunManifest;
}

function validateNodeState(value: unknown, path: string): NodeStateRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "node-state" ||
    typeof value.runId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.taskKey !== "string" ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) <= 0 ||
    typeof value.status !== "string" ||
    !NODE_STATUSES.has(value.status as NodeStatus) ||
    !isTimestamp(value.updatedAt)
  ) {
    return invalidRecord(path, "node state does not match schema version 1");
  }
  return value as unknown as NodeStateRecord;
}

/**
 * Artifact text is bounded and non-blank but otherwise unconstrained: it is
 * retained verbatim for a reader, never interpreted by the runtime. Absence
 * is rejected here, because every caller has already decided the artifact is
 * present.
 */
function parseArtifactText(value: unknown): string {
  let text: string | undefined;
  try {
    text = parseNodeArtifact(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    throw new RunStoreError(
      "invalid_argument",
      `A text artifact must be non-blank and at most ${NODE_OUTPUT_LIMITS.maxArtifactBytes} bytes`,
    );
  }
  return text;
}

function validArtifactReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Number.isInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    (value.bytes as number) <= NODE_OUTPUT_LIMITS.maxArtifactBytes
  );
}

function validateNodeArtifact(
  value: unknown,
  path: string,
): NodeArtifactRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "node-artifact" ||
    typeof value.runId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.taskKey !== "string" ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) <= 0 ||
    !isTimestamp(value.publishedAt) ||
    Object.keys(value).some((field) => !NODE_ARTIFACT_RECORD_FIELDS.has(field))
  ) {
    return invalidRecord(path, "node artifact does not match schema version 1");
  }
  let text: string;
  try {
    text = parseArtifactText(value.text);
  } catch {
    return invalidRecord(path, "node artifact text is invalid or oversized");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "node-artifact",
    runId: value.runId,
    taskId: value.taskId,
    taskKey: value.taskKey,
    attempt: value.attempt as number,
    publishedAt: value.publishedAt,
    text,
  };
}

function validateNodeOutputRecord(
  value: unknown,
  path: string,
): NodeOutputRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "node-output" ||
    typeof value.runId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.taskKey !== "string" ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) <= 0 ||
    typeof value.status !== "string" ||
    !OUTPUT_STATUSES.has(value.status as NodeOutputStatus) ||
    !isTimestamp(value.completedAt) ||
    Object.keys(value).some((field) => !NODE_OUTPUT_RECORD_FIELDS.has(field))
  ) {
    return invalidRecord(path, "node output does not match schema version 1");
  }
  if ("artifact" in value && !validArtifactReference(value.artifact)) {
    return invalidRecord(path, "node output has an invalid artifact reference");
  }
  let usage: TaskUsage | undefined;
  try {
    usage = parseTaskUsage(value.usage);
  } catch {
    return invalidRecord(path, "node output has invalid usage");
  }

  let diagnostics: string | undefined;
  try {
    diagnostics = parseNodeDiagnostics(value.diagnostics);
  } catch {
    return invalidRecord(path, "node output has invalid diagnostics");
  }
  const base: NodeOutputRecordBase = {
    schemaVersion: SCHEMA_VERSION,
    kind: "node-output",
    runId: value.runId,
    taskId: value.taskId,
    taskKey: value.taskKey,
    attempt: value.attempt as number,
    completedAt: value.completedAt,
    ...(value.artifact === undefined
      ? {}
      : {
          artifact: { bytes: (value.artifact as NodeArtifactReference).bytes },
        }),
    ...(usage === undefined ? {} : { usage }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };

  if (value.status === "succeeded") {
    if (!("output" in value)) {
      return invalidRecord(path, "succeeded node output is missing its report");
    }
    let output: NodeOutput;
    try {
      output = parseNodeOutput(value.output);
    } catch {
      return invalidRecord(path, "succeeded node output has an invalid report");
    }
    if (output.blockers.length > 0) {
      return invalidRecord(
        path,
        "succeeded node output report contains blockers",
      );
    }
    return { ...base, status: value.status, output };
  }
  if (value.status === "failed") {
    if (!("output" in value)) return { ...base, status: value.status };
    try {
      return {
        ...base,
        status: value.status,
        output: parseNodeOutput(value.output),
      };
    } catch {
      return invalidRecord(path, "failed node output has an invalid report");
    }
  }
  if ("output" in value) {
    return invalidRecord(path, "aborted node output contains a report");
  }
  return { ...base, status: "aborted" };
}

function findTask(manifest: RunManifest, taskId: string): RunManifestTask {
  const task = manifest.graph.tasks.find(
    (candidate) => candidate.id === taskId,
  );
  if (!task) {
    throw new RunStoreError(
      "unknown_task",
      `Run ${JSON.stringify(manifest.runId)} has no task ${JSON.stringify(taskId)}`,
    );
  }
  return task;
}

function assertIdentity(
  path: string,
  manifest: RunManifest,
  task: RunManifestTask,
  record: NodeStateRecord | NodeOutputRecord | NodeArtifactRecord,
): void {
  if (
    record.runId !== manifest.runId ||
    record.taskId !== task.id ||
    record.taskKey !== task.key
  ) {
    invalidRecord(path, "record identity does not match its run and task");
  }
}

async function readNodeStateRecord(
  stateRoot: string,
  manifest: RunManifest,
  task: RunManifestTask,
): Promise<NodeStateRecord> {
  const path = join(
    runPath(stateRoot, manifest.runId),
    "nodes",
    `${task.key}.json`,
  );
  const record = validateNodeState(await readJson(path), path);
  assertIdentity(path, manifest, task, record);
  return record;
}

async function readNodeOutputRecord(
  stateRoot: string,
  manifest: RunManifest,
  task: RunManifestTask,
): Promise<NodeOutputRecord> {
  const path = join(
    runPath(stateRoot, manifest.runId),
    "outputs",
    `${task.key}.json`,
  );
  const record = validateNodeOutputRecord(await readJson(path), path);
  assertIdentity(path, manifest, task, record);
  return record;
}

function artifactPath(
  stateRoot: string,
  runId: string,
  taskKey: string,
): string {
  return join(
    runPath(stateRoot, runId),
    RUN_ARTIFACT_DIRECTORY,
    `${taskKey}.json`,
  );
}

async function readNodeArtifactRecord(
  stateRoot: string,
  manifest: RunManifest,
  task: RunManifestTask,
): Promise<NodeArtifactRecord> {
  const path = artifactPath(stateRoot, manifest.runId, task.key);
  const record = validateNodeArtifact(await readJson(path), path);
  assertIdentity(path, manifest, task, record);
  return record;
}

function graphFromManifest(manifest: RunManifest): NormalizedGraph<JsonValue> {
  return normalizeGraph({
    tasks: manifest.graph.tasks.map((task) => ({
      id: task.id,
      needs: task.needs,
      ...(task.payload === undefined ? {} : { payload: task.payload }),
    })),
    ...(manifest.graph.concurrency === undefined
      ? {}
      : { concurrency: manifest.graph.concurrency }),
  });
}

export async function createRun<TPayload>(
  stateRoot: string,
  graph: NormalizedGraph<TPayload>,
  maximumRuns = RUN_STORE_DEFAULT_MAX_RUNS,
): Promise<RunManifest> {
  const root = stateRootPath(stateRoot);
  if (
    !Number.isInteger(maximumRuns) ||
    maximumRuns <= 0 ||
    maximumRuns > RUN_STORE_MAX_RUNS
  ) {
    throw new RunStoreError(
      "invalid_argument",
      `The maximum retained run count must be between 1 and ${RUN_STORE_MAX_RUNS}`,
    );
  }
  const validatedGraph = normalizeGraph({
    tasks: graph.tasks,
    ...(graph.concurrency === undefined
      ? {}
      : { concurrency: graph.concurrency }),
  });
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const tasks: RunManifestTask[] = validatedGraph.tasks.map((task) => {
    if (task.payload !== undefined && !isJsonValue(task.payload)) {
      throw new RunStoreError(
        "invalid_argument",
        `Payload for task ${JSON.stringify(task.id)} is not a JSON value`,
      );
    }
    return {
      id: task.id,
      key: `task-${randomUUID()}`,
      needs: [...task.needs],
      ...(task.payload === undefined
        ? {}
        : { payload: task.payload as JsonValue }),
    };
  });
  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "run-manifest",
    runId,
    createdAt,
    graph: {
      tasks,
      ...(validatedGraph.concurrency === undefined
        ? {}
        : { concurrency: validatedGraph.concurrency }),
    },
  };

  serializedRecord(manifest);
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(runs, DIRECTORY_MODE);
  const finalRunPath = join(runs, runId);
  const temporaryRunPath = join(runs, `.${runId}.${randomUUID()}.tmp`);
  let slotPath: string | undefined;
  let published = false;
  try {
    await mkdir(temporaryRunPath, { mode: DIRECTORY_MODE });
    for (const directory of [
      "nodes",
      "outputs",
      RUN_ARTIFACT_DIRECTORY,
      RUN_COORDINATION_DIRECTORY,
    ]) {
      await mkdir(join(temporaryRunPath, directory), { mode: DIRECTORY_MODE });
    }
    await writeNewFile(join(temporaryRunPath, "run.json"), manifest);
    for (const task of tasks) {
      const state: NodeStateRecord = {
        schemaVersion: SCHEMA_VERSION,
        kind: "node-state",
        runId,
        taskId: task.id,
        taskKey: task.key,
        attempt: 1,
        status: "pending",
        updatedAt: createdAt,
      };
      await writeNewFile(
        join(temporaryRunPath, "nodes", `${task.key}.json`),
        state,
      );
    }
    // The slot is claimed as late as possible, so an interrupted creation can
    // only strand one between this call and the rename that publishes the run.
    slotPath = await claimRunSlot(runs, runId, maximumRuns);
    await rename(temporaryRunPath, finalRunPath);
    published = true;
  } finally {
    await rm(temporaryRunPath, { recursive: true, force: true });
    if (!published && slotPath !== undefined) {
      await releaseRunSlot(slotPath, runId);
    }
  }

  return manifest;
}

export async function acquireRunOwnership(
  stateRoot: string,
  runId: string,
): Promise<RunOwnership> {
  // Validate the run before creating an owner record, so ownership can never
  // accidentally create a new addressable run.
  await readRun(stateRoot, runId);
  const path = ownerPath(stateRoot, runId);
  const ownership = Object.freeze({
    runId,
    ownerId: randomUUID(),
  });
  const releaseMutationLock = await acquireRunMutationLock(stateRoot, runId);
  try {
    try {
      await writeNewFile(path, {
        schemaVersion: SCHEMA_VERSION,
        kind: "run-owner",
        runId,
        ownerId: ownership.ownerId,
        acquiredAt: new Date().toISOString(),
      });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new RunStoreError(
          "ownership",
          `Run ${JSON.stringify(runId)} is already owned by another orchestrator`,
          path,
        );
      }
      throw error;
    }
    return ownership;
  } finally {
    await releaseMutationLock();
  }
}

/**
 * Names every run and every capacity slot the store retains.
 *
 * Cleanup is explicit and by name, so an operator has to be able to see what
 * holds capacity before choosing what to give up. Reads are per run, which is
 * why this is a maintenance call and not something the run lifecycle uses.
 */
export async function listRetainedRuns(
  stateRoot: string,
): Promise<readonly RetainedRun[]> {
  const runs = runsPath(stateRoot);
  let published: ReadonlySet<string>;
  try {
    published = await publishedRunIds(runs);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const claims = await readSlotClaims(join(runs, RUN_SLOT_DIRECTORY));
  const slotted = new Set(claims.flatMap((claim) => claim.owner ?? []));
  const entries = await Promise.all([
    ...claims.map((claim) => retainedRun(stateRoot, claim.owner, claim.index)),
    ...[...published]
      .filter((runId) => !slotted.has(runId))
      .map((runId) => retainedRun(stateRoot, runId, undefined)),
  ]);
  // Oldest first, so the entries an operator is most likely to give up come
  // first; entries with no run directory sort last, by slot.
  return Object.freeze(
    entries.sort(
      (left, right) =>
        (left.createdAt ?? "\uffff").localeCompare(
          right.createdAt ?? "\uffff",
        ) ||
        (left.runId ?? "").localeCompare(right.runId ?? "") ||
        (left.slot ?? 0) - (right.slot ?? 0),
    ),
  );
}

async function retainedRun(
  stateRoot: string,
  runId: string | undefined,
  slot: number | undefined,
): Promise<RetainedRun> {
  if (runId === undefined)
    return { owned: false, ...(slot === undefined ? {} : { slot }) };
  let createdAt: string | undefined;
  try {
    createdAt = (await readRun(stateRoot, runId)).createdAt;
  } catch (error) {
    // This listing is what an operator reads when the store is already in
    // trouble, so one run it cannot read must not hide the rest. The entry
    // still names the run, which is all `deleteRun` needs. A slot naming a run
    // that was never published, or one already removed, reads the same way.
    if (!(error instanceof RunStoreError)) throw error;
  }
  return {
    runId,
    ...(slot === undefined ? {} : { slot }),
    ...(createdAt === undefined ? {} : { createdAt }),
    // Read the way `deleteRun` reads it, so the listing never reports a run as
    // free that deletion then refuses.
    owned: await runHasOwner(stateRoot, runId),
  };
}

/**
 * Only a missing owner record proves a run is unowned. Anything else in its
 * place is treated as an owner, so cleanup fails closed rather than deleting
 * state an orchestrator may still be writing.
 */
async function runHasOwner(stateRoot: string, runId: string): Promise<boolean> {
  try {
    await readJson(ownerPath(stateRoot, runId));
  } catch (error) {
    return !(error instanceof RunStoreError && error.code === "not_found");
  }
  return true;
}

async function findRunSlot(
  slots: string,
  runId: string,
): Promise<string | undefined> {
  let entries: readonly import("node:fs").Dirent<string>[];
  try {
    entries = await readdir(slots, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !RUN_SLOT_PATTERN.test(entry.name)) continue;
    const path = join(slots, entry.name);
    if ((await slotOwner(path)) === runId) return path;
  }
  return undefined;
}

/**
 * Removes one run's directory and its capacity slot, and reports whether
 * anything was there to remove.
 *
 * The run is named rather than selected by age or count: nothing here may
 * decide on an operator's behalf which diagnostic state is worth losing. A run
 * an orchestrator still holds is refused, and the mutation lock is held across
 * that check so ownership cannot be acquired between it and the removal.
 *
 * The directory goes first and the slot second. An interruption then strands a
 * slot, which the store already reports as reclaimable capacity, instead of
 * leaving a published run whose slot is missing — the disagreement that stops
 * the store admitting any work at all.
 */
export async function deleteRun(
  stateRoot: string,
  runId: string,
): Promise<boolean> {
  assertRunId(runId);
  const runs = runsPath(stateRoot);
  const slot = await findRunSlot(join(runs, RUN_SLOT_DIRECTORY), runId);
  let removed = false;
  let releaseMutationLock: (() => Promise<void>) | undefined;
  try {
    releaseMutationLock = await acquireRunMutationLock(stateRoot, runId);
  } catch (error) {
    // With no run directory there is only a stranded slot left to release.
    if (!(error instanceof RunStoreError) || error.code !== "not_found") {
      throw error;
    }
  }
  if (releaseMutationLock !== undefined) {
    try {
      if (await runHasOwner(stateRoot, runId)) {
        throw new RunStoreError(
          "ownership",
          `Run ${JSON.stringify(runId)} is owned by an orchestrator`,
          ownerPath(stateRoot, runId),
        );
      }
      await rm(join(runs, runId), { recursive: true, force: true });
      removed = true;
    } finally {
      // The lock lived inside the directory, so this is now a no-op.
      await releaseMutationLock();
    }
  }
  if (slot !== undefined) {
    await releaseRunSlot(slot, runId);
    removed = true;
  }
  return removed;
}

/**
 * Removes a mutation lock left behind by a task executor, and reports whether
 * one was removed. Only the run's owner may recover a lock; ordinary callers
 * must use the lock release returned by the mutation operation instead.
 *
 * `isHolderFinished` decides whether a lock that is still in place is stale.
 * The graph runner passes it while workers may still be running, and answers
 * only for a task of this run whose lifecycle has ended, so contention with a
 * live worker is left alone rather than resolved by taking its lock away. A
 * lock naming no task, or one this state root cannot attribute, is never
 * recovered on that path. Omitting the predicate recovers unconditionally and
 * is correct only once every task promise has settled.
 */
export async function recoverRunMutationLock(
  stateRoot: string,
  ownership: RunOwnership,
  isHolderFinished?: (taskId: string) => boolean,
): Promise<boolean> {
  const capability = parseOwnershipCapability(ownership);
  const runId = capability.runId;
  assertRunId(runId);
  const owner = ownerPath(stateRoot, runId);
  try {
    const record = validateRunOwnership(await readJson(owner), owner);
    if (record.runId !== runId || record.ownerId !== capability.ownerId) {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is owned by another orchestrator`,
        owner,
      );
    }
  } catch (error) {
    if (error instanceof RunStoreError && error.code === "not_found") {
      return false;
    }
    throw error;
  }
  const path = join(runPath(stateRoot, runId), RUN_MUTATION_LOCK);
  if (isHolderFinished !== undefined) {
    let holder: RunMutationLockRecord;
    try {
      holder = validateRunMutationLock(await readJson(path), path);
    } catch (error) {
      // The lock was released while it was being read, so there is nothing to
      // recover and the caller should simply retry its mutation.
      if (error instanceof RunStoreError && error.code === "not_found") {
        return false;
      }
      // Anything else in the lock's place is reported as the invalid record it
      // is, rather than escaping as a bare filesystem error.
      if (!(error instanceof RunStoreError)) {
        return invalidRecord(path, "run mutation lock could not be read");
      }
      throw error;
    }
    if (holder.runId !== runId) {
      invalidRecord(path, "run mutation lock does not match its run");
    }
    if (holder.taskId === undefined || !isHolderFinished(holder.taskId)) {
      return false;
    }
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

export async function releaseRunOwnership(
  stateRoot: string,
  ownership: RunOwnership,
): Promise<void> {
  const capability = parseOwnershipCapability(ownership);
  const runId = capability.runId;
  assertRunId(runId);
  const path = ownerPath(stateRoot, runId);
  let releaseMutationLock: (() => Promise<void>) | undefined;
  try {
    releaseMutationLock = await acquireRunMutationLock(stateRoot, runId);
  } catch (error) {
    if (
      errorCode(error) === "ENOENT" ||
      (error instanceof RunStoreError && error.code === "not_found")
    ) {
      return;
    }
    throw error;
  }
  try {
    let record: RunOwnership;
    try {
      record = validateRunOwnership(await readJson(path), path);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "not_found") return;
      throw error;
    }
    if (record.runId !== runId || record.ownerId !== capability.ownerId) {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is owned by another orchestrator`,
        path,
      );
    }
    try {
      await rm(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  } finally {
    await releaseMutationLock();
  }
}

export async function readRun(
  stateRoot: string,
  runId: string,
): Promise<RunManifest> {
  const path = join(runPath(stateRoot, runId), "run.json");
  const manifest = validateManifest(await readJson(path), path);
  if (manifest.runId !== runId) {
    invalidRecord(path, "manifest run ID does not match its directory");
  }
  return manifest;
}

export async function readNodeState(
  stateRoot: string,
  runId: string,
  taskId: string,
): Promise<NodeStateRecord> {
  const manifest = await readRun(stateRoot, runId);
  return readNodeStateRecord(stateRoot, manifest, findTask(manifest, taskId));
}

/**
 * Validates and persists one graph transition. Every mutation requires the
 * caller to hold the run's exclusive ownership record.
 */
export async function writeNodeState(
  stateRoot: string,
  runId: string,
  taskId: string,
  status: NodeStatus,
  ownership: RunOwnership,
): Promise<NodeStateRecord> {
  const releaseMutationLock = await assertRunOwnership(
    stateRoot,
    runId,
    ownership,
  );
  try {
    return await writeNodeStateUnlocked(stateRoot, runId, taskId, status);
  } finally {
    await releaseMutationLock();
  }
}

async function writeNodeStateUnlocked(
  stateRoot: string,
  runId: string,
  taskId: string,
  status: NodeStatus,
): Promise<NodeStateRecord> {
  if (!NODE_STATUSES.has(status)) {
    throw new RunStoreError(
      "invalid_argument",
      `Invalid node status ${JSON.stringify(status)}`,
    );
  }
  const manifest = await readRun(stateRoot, runId);
  const task = findTask(manifest, taskId);
  const states = await Promise.all(
    manifest.graph.tasks.map((candidate) =>
      readNodeStateRecord(stateRoot, manifest, candidate),
    ),
  );
  const current = states.find((candidate) => candidate.taskId === task.id);
  if (!current) {
    throw new RunStoreError(
      "invalid_record",
      `Run is missing node state for task ${JSON.stringify(task.id)}`,
    );
  }
  if (current.status === status) return current;

  const graph = graphFromManifest(manifest);
  const graphState = new Map(
    states.map((candidate) => [candidate.taskId, candidate.status] as const),
  ) as GraphState;
  try {
    if (status === "blocked") {
      if (settleBlocked(graph, graphState).get(task.id) !== "blocked") {
        throw new Error(
          `Task ${JSON.stringify(task.id)} has no blocking prerequisite`,
        );
      }
    } else {
      setNodeStatus(graph, graphState, task.id, status);
    }
  } catch (error) {
    throw new RunStoreError(
      "invalid_record",
      error instanceof Error ? error.message : "Invalid node transition",
    );
  }

  if (OUTPUT_STATUSES.has(status as NodeOutputStatus)) {
    let output: NodeOutputRecord;
    try {
      output = await readNodeOutputRecord(stateRoot, manifest, task);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "not_found") {
        throw new RunStoreError(
          "invalid_record",
          `Terminal state ${JSON.stringify(status)} requires a published output`,
        );
      }
      throw error;
    }
    if (output.status !== status || output.attempt !== current.attempt) {
      throw new RunStoreError(
        "invalid_record",
        "Terminal state does not match the published output",
      );
    }
  }

  const path = join(runPath(stateRoot, runId), "nodes", `${task.key}.json`);
  const record: NodeStateRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: "node-state",
    runId,
    taskId: task.id,
    taskKey: task.key,
    attempt: current.attempt,
    status,
    updatedAt: new Date().toISOString(),
  };
  await replaceRecord(path, record);
  return record;
}

export async function publishNodeOutput(
  stateRoot: string,
  runId: string,
  input: PublishNodeOutput,
  ownership: RunOwnership,
): Promise<NodeOutputRecord> {
  const releaseMutationLock = await assertRunOwnership(
    stateRoot,
    runId,
    ownership,
  );
  try {
    return await publishNodeOutputUnlocked(stateRoot, runId, input);
  } finally {
    await releaseMutationLock();
  }
}

async function publishNodeOutputUnlocked(
  stateRoot: string,
  runId: string,
  input: PublishNodeOutput,
): Promise<NodeOutputRecord> {
  if (!OUTPUT_STATUSES.has(input.status)) {
    throw new RunStoreError(
      "invalid_argument",
      `Invalid node output status ${JSON.stringify(input.status)}`,
    );
  }
  let output: NodeOutput | undefined;
  if (input.status === "aborted" && "output" in input) {
    throw new RunStoreError(
      "invalid_argument",
      `Aborted task ${JSON.stringify(input.taskId)} must not publish a node report`,
    );
  }
  if (input.status === "succeeded" || "output" in input) {
    try {
      output = parseNodeOutput(input.output);
    } catch {
      throw new RunStoreError(
        "invalid_argument",
        `Output for task ${JSON.stringify(input.taskId)} is not a valid node report`,
      );
    }
  }
  if (input.status === "succeeded" && output?.blockers.length) {
    throw new RunStoreError(
      "invalid_argument",
      `Succeeded task ${JSON.stringify(input.taskId)} must not report blockers`,
    );
  }
  // An aborted task published nothing, so it has no long-form text to retain.
  // Every other status may, whether or not it also produced a report.
  let artifact: string | undefined;
  if ((input as { artifact?: unknown }).artifact !== undefined) {
    if (input.status === "aborted") {
      throw new RunStoreError(
        "invalid_argument",
        `Aborted task ${JSON.stringify(input.taskId)} must not publish a text artifact`,
      );
    }
    try {
      artifact = parseArtifactText((input as { artifact?: unknown }).artifact);
    } catch {
      throw new RunStoreError(
        "invalid_argument",
        `Text artifact for task ${JSON.stringify(input.taskId)} is invalid or oversized`,
      );
    }
  }
  let usage: TaskUsage | undefined;
  try {
    usage = parseTaskUsage(input.usage);
  } catch {
    throw new RunStoreError(
      "invalid_argument",
      `Usage for task ${JSON.stringify(input.taskId)} is invalid or out of range`,
    );
  }
  let diagnostics: string | undefined;
  try {
    diagnostics = parseNodeDiagnostics(input.diagnostics);
  } catch {
    throw new RunStoreError(
      "invalid_argument",
      `Diagnostics for task ${JSON.stringify(input.taskId)} are invalid or oversized`,
    );
  }
  const manifest = await readRun(stateRoot, runId);
  const task = findTask(manifest, input.taskId);
  const state = await readNodeStateRecord(stateRoot, manifest, task);
  const canPublish =
    state.status === "running" ||
    (state.status === "pending" && input.status !== "succeeded") ||
    state.status === input.status;
  if (!canPublish) {
    throw new RunStoreError(
      "invalid_record",
      `Output status ${JSON.stringify(input.status)} conflicts with node status ${JSON.stringify(state.status)}`,
    );
  }

  // The artifact is published first, so an interruption can only strand an
  // artifact no output claims. Publishing the output first would leave a
  // reference to a file that does not exist.
  const publishedAt = new Date().toISOString();
  if (artifact !== undefined) {
    const artifactRecord: NodeArtifactRecord = {
      schemaVersion: SCHEMA_VERSION,
      kind: "node-artifact",
      runId,
      taskId: task.id,
      taskKey: task.key,
      attempt: state.attempt,
      publishedAt,
      text: artifact,
    };
    await publishRecord(
      artifactPath(stateRoot, runId, task.key),
      artifactRecord,
    );
  }

  const path = join(runPath(stateRoot, runId), "outputs", `${task.key}.json`);
  const baseRecord: NodeOutputRecordBase = {
    schemaVersion: SCHEMA_VERSION,
    kind: "node-output",
    runId,
    taskId: task.id,
    taskKey: task.key,
    attempt: state.attempt,
    completedAt: publishedAt,
    ...(artifact === undefined
      ? {}
      : { artifact: { bytes: Buffer.byteLength(artifact, "utf8") } }),
    ...(usage === undefined ? {} : { usage }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
  let record: NodeOutputRecord;
  if (input.status === "succeeded") {
    if (output === undefined) {
      throw new Error("Validated node report is unexpectedly missing");
    }
    record = { ...baseRecord, status: input.status, output };
  } else if (input.status === "failed") {
    record = {
      ...baseRecord,
      status: input.status,
      ...(output === undefined ? {} : { output }),
    };
  } else {
    record = { ...baseRecord, status: input.status };
  }
  await publishRecord(path, record);
  return record;
}

function parsePublishRunEvent(value: unknown): PublishRunEvent {
  try {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (field) =>
          !new Set([
            "taskId",
            "eventKind",
            "message",
            "paths",
            "symbols",
            "recipients",
          ]).has(field),
      )
    ) {
      throw new Error("invalid event");
    }
    const eventKind = value.eventKind;
    if (
      typeof eventKind !== "string" ||
      !RUN_EVENT_KINDS.has(eventKind as RunEventKind)
    ) {
      throw new Error("invalid event kind");
    }
    const taskId = coordinationText(value.taskId, "task ID");
    const message = coordinationText(value.message, "message");
    const paths = coordinationList(
      value.paths,
      "paths",
      RUN_COORDINATION_MAX_ITEM_BYTES,
    );
    const symbols = coordinationList(
      value.symbols,
      "symbols",
      RUN_COORDINATION_MAX_ITEM_BYTES,
    );
    const recipients = coordinationList(
      value.recipients,
      "recipients",
      RUN_COORDINATION_MAX_TEXT_BYTES,
    );
    return {
      taskId,
      eventKind: eventKind as RunEventKind,
      message,
      ...(paths === undefined ? {} : { paths }),
      ...(symbols === undefined ? {} : { symbols }),
      ...(recipients === undefined ? {} : { recipients }),
    };
  } catch {
    throw new RunStoreError(
      "invalid_argument",
      "Run event is invalid or oversized",
    );
  }
}

function parsePublishRunMessage(value: unknown): PublishRunMessage {
  try {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (field) =>
          !new Set(["senderTaskId", "recipientTaskId", "message"]).has(field),
      )
    ) {
      throw new Error("invalid message");
    }
    return {
      senderTaskId: coordinationText(value.senderTaskId, "sender task ID"),
      recipientTaskId: coordinationText(
        value.recipientTaskId,
        "recipient task ID",
      ),
      message: coordinationText(value.message, "message"),
    };
  } catch {
    throw new RunStoreError(
      "invalid_argument",
      "Run message is invalid or oversized",
    );
  }
}

function parseRunEventQuery(value: unknown): RunEventQuery {
  try {
    if (value === undefined) return {};
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (field) =>
          !new Set([
            "cursor",
            "eventKind",
            "recipient",
            "path",
            "symbol",
            "limit",
          ]).has(field),
      )
    ) {
      throw new Error("invalid event query");
    }
    const cursor = coordinationCursor(value.cursor);
    const eventKind = value.eventKind;
    if (
      eventKind !== undefined &&
      (typeof eventKind !== "string" ||
        !RUN_EVENT_KINDS.has(eventKind as RunEventKind))
    ) {
      throw new Error("invalid event kind");
    }
    const recipient =
      value.recipient === undefined
        ? undefined
        : coordinationText(value.recipient, "recipient");
    const path =
      value.path === undefined
        ? undefined
        : coordinationText(value.path, "path", RUN_COORDINATION_MAX_ITEM_BYTES);
    const symbol =
      value.symbol === undefined
        ? undefined
        : coordinationText(
            value.symbol,
            "symbol",
            RUN_COORDINATION_MAX_ITEM_BYTES,
          );
    const limit = coordinationLimit(value.limit);
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(eventKind === undefined
        ? {}
        : { eventKind: eventKind as RunEventKind }),
      ...(recipient === undefined ? {} : { recipient }),
      ...(path === undefined ? {} : { path }),
      ...(symbol === undefined ? {} : { symbol }),
      limit,
    };
  } catch {
    throw new RunStoreError("invalid_argument", "Run event query is invalid");
  }
}

function parseRunMessageQuery(value: unknown): RunMessageQuery {
  try {
    if (value === undefined) return {};
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (field) => !new Set(["cursor", "limit"]).has(field),
      )
    ) {
      throw new Error("invalid message query");
    }
    const cursor = coordinationCursor(value.cursor);
    const limit = coordinationLimit(value.limit);
    return { ...(cursor === undefined ? {} : { cursor }), limit };
  } catch {
    throw new RunStoreError("invalid_argument", "Run message query is invalid");
  }
}

async function coordinationFiles(
  directory: string,
): Promise<readonly string[]> {
  let entries: readonly import("node:fs").Dirent<string>[];
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new RunStoreError(
        "not_found",
        `Coordination directory not found at ${JSON.stringify(directory)}`,
        directory,
      );
    }
    throw error;
  }
  // Identifiers are fixed-width, so sorting the names sorts the sequence.
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(RECORD_SUFFIX) &&
        COORDINATION_ID_PATTERN.test(recordId(entry.name)),
    )
    .map((entry) => entry.name)
    .sort();
  if (files.length > RUN_COORDINATION_MAX_RECORDS) {
    throw new RunStoreError(
      "record_too_large",
      `Coordination records exceed the retained limit of ${RUN_COORDINATION_MAX_RECORDS}`,
      directory,
    );
  }
  return files;
}

/**
 * Coordination records are published by workers, which never hold the
 * orchestrator's ownership capability: that capability authorizes node state
 * and output mutations for the whole run. Requiring an owner record rather than
 * the capability itself keeps an unowned or finished run immutable while
 * leaving worker writes unprivileged.
 *
 * Records are therefore attributed to a task rather than authenticated. Every
 * worker of a run shares this state root, exactly as they share the checkout.
 */
async function withActiveRunPublication<T>(
  stateRoot: string,
  runId: string,
  holderTaskId: string,
  publish: (manifest: RunManifest, holder: RunManifestTask) => Promise<T>,
): Promise<T> {
  // The lock names its holder and the graph runner acts on that name, so the
  // task is resolved against the manifest before it is written and a worker
  // cannot label its lock with another task. A published run's manifest is
  // immutable, so it is read once and outside the lock; only the active-owner
  // check has to be synchronized with ownership release.
  const manifest = await readRun(stateRoot, runId);
  const holder = findTask(manifest, holderTaskId);
  const releaseMutationLock = await acquireRunMutationLock(
    stateRoot,
    runId,
    holder.id,
  );
  try {
    await assertActiveRunOwner(stateRoot, runId);
    return await publish(manifest, holder);
  } finally {
    await releaseMutationLock();
  }
}

async function assertActiveRunOwner(
  stateRoot: string,
  runId: string,
): Promise<void> {
  const path = ownerPath(stateRoot, runId);
  let owner: RunOwnership;
  try {
    owner = validateRunOwnership(await readJson(path), path);
  } catch (error) {
    if (error instanceof RunStoreError && error.code === "not_found") {
      throw new RunStoreError(
        "ownership",
        `Run ${JSON.stringify(runId)} is not owned by an orchestrator`,
        path,
      );
    }
    throw error;
  }
  if (owner.runId !== runId) {
    invalidRecord(path, "run ownership does not match its run");
  }
}

/**
 * Coordination records are ordered by one run-global sequence, so a cursor
 * names a position that no later record can precede and a reader polling with
 * one can never skip a record.
 *
 * The caller holds the run mutation lock while checking ownership and invoking
 * this function, so publishers of one run do not race each other. Claiming a
 * sequence number and publishing the record it names are still one exclusive
 * create in the journal, so a failed attempt leaves no identifier behind and
 * a writer that ignored the lock cannot take an identifier already used. The
 * lock additionally prevents ownership release from landing between the
 * active-run check and publication.
 */
async function publishCoordinationRecord<TRecord>(
  stateRoot: string,
  runId: string,
  build: (id: string) => TRecord,
): Promise<TRecord> {
  const directory = coordinationDirectory(stateRoot, runId);
  for (let attempt = 0; attempt < COORDINATION_PUBLISH_ATTEMPTS; attempt += 1) {
    const published = await coordinationFiles(directory);
    const previous = published.at(-1);
    const sequence =
      previous === undefined ? 1 : Number.parseInt(recordId(previous), 10) + 1;
    if (
      published.length >= RUN_COORDINATION_MAX_RECORDS ||
      sequence > MAX_COORDINATION_SEQUENCE
    ) {
      throw new RunStoreError(
        "retention_limit",
        `Run ${JSON.stringify(runId)} retains the maximum of ${RUN_COORDINATION_MAX_RECORDS} coordination records`,
        directory,
      );
    }
    const id = String(sequence).padStart(RUN_COORDINATION_ID_LENGTH, "0");
    const record = build(id);
    // Bounded as a whole rather than field by field: the guarantee a reader
    // depends on is that one record always fits in one page.
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > RUN_COORDINATION_MAX_RECORD_BYTES) {
      throw new RunStoreError(
        "record_too_large",
        `Coordination record of ${bytes} bytes exceeds the bound of ${RUN_COORDINATION_MAX_RECORD_BYTES} bytes`,
        directory,
      );
    }
    try {
      await publishRecord(join(directory, `${id}${RECORD_SUFFIX}`), record);
      return record;
    } catch (error) {
      if (!(error instanceof RunStoreError) || error.code !== "record_exists") {
        throw error;
      }
    }
  }
  // Publication is serialized by the run mutation lock, so the identifier the
  // journal reports as free is normally free. Exhausting the attempts means
  // something outside that lock is writing into the journal.
  throw new RunStoreError(
    "record_exists",
    `Run ${JSON.stringify(runId)} could not claim a coordination identifier`,
    directory,
  );
}

interface CoordinationEntry {
  readonly id: string;
  readonly path: string;
}

/**
 * Names every record after `cursor`, in sequence order, without reading any of
 * them. Both kinds share the journal and filtered records still have to be
 * read, so a page cannot be bounded here, but a cursor prunes the common
 * polling case to the new records alone.
 */
async function coordinationEntries(
  stateRoot: string,
  runId: string,
  cursor: string | undefined,
): Promise<readonly CoordinationEntry[]> {
  const directory = coordinationDirectory(stateRoot, runId);
  return (await coordinationFiles(directory))
    .map((file) => ({ id: recordId(file), path: join(directory, file) }))
    .filter((entry) => cursor === undefined || entry.id > cursor);
}

interface CoordinationPage<TRecord> {
  readonly records: readonly TRecord[];
  readonly nextCursor?: string;
}

/**
 * Reads entries in sequence order until the requested count or the page byte
 * bound is reached, and reports a cursor for the rest. A following page can be
 * empty, because a cursor is also returned when what remains behind it is only
 * entries this reader is never given.
 *
 * Both kinds share one journal, so a reader passes over entries it will never
 * return: the other kind, and another task's mail. Those are behind the cursor
 * once they have been examined, so a poller reads each of them once rather
 * than re-reading the whole journal on every call. An entry examined but held
 * back — the one that overflowed the page — stays ahead of the cursor. A
 * cursor therefore belongs to the query that produced it: reused under a
 * different filter or a different recipient, it starts past records that
 * filter would have matched.
 *
 * Every record is bounded when it is published, so a page always has room for
 * its first record and the byte bound holds without an exception for it.
 */
async function readCoordinationPage<TRecord>(
  entries: readonly CoordinationEntry[],
  limit: number,
  select: (entry: CoordinationEntry) => Promise<TRecord | undefined>,
): Promise<CoordinationPage<TRecord>> {
  const records: TRecord[] = [];
  // Account for the JSON array brackets and separators as well as records.
  let bytes = 0;
  let cursor: string | undefined;
  let examined: string | undefined;
  // Reached only with at least one record in the page, so the cursor is always
  // the identifier of a record the caller has now seen.
  const truncated = (): CoordinationPage<TRecord> =>
    cursor === undefined ? { records } : { records, nextCursor: cursor };
  for (const entry of entries) {
    if (records.length >= limit) return truncated();
    const record = await select(entry);
    if (record === undefined) {
      examined = entry.id;
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(record));
    if (size > RUN_COORDINATION_MAX_RECORD_BYTES) {
      return invalidRecord(
        entry.path,
        "coordination record exceeds its serialized bound",
      );
    }
    const pageBytes = bytes + size + (records.length === 0 ? 2 : 1);
    if (pageBytes > RUN_COORDINATION_MAX_PAGE_BYTES) return truncated();
    records.push(record);
    bytes = pageBytes;
    cursor = entry.id;
    examined = entry.id;
  }
  // Nothing was held back, so the position runs to the last entry examined.
  return examined === undefined || examined === cursor
    ? { records }
    : { records, nextCursor: examined };
}

type CoordinationRecordKind = "run-event" | "run-message";

/**
 * Both kinds share the journal, so a reader has to look before validating.
 * Anything else in there is a tampered record, not a record to skip.
 */
function coordinationRecordKind(
  value: unknown,
  path: string,
): CoordinationRecordKind {
  if (
    !isRecord(value) ||
    (value.kind !== "run-event" && value.kind !== "run-message")
  ) {
    return invalidRecord(
      path,
      "coordination record is neither an event nor a message",
    );
  }
  return value.kind;
}

/**
 * A record names its own task rather than inheriting one from its path, so a
 * reader checks that the task is still one of the run's before returning it.
 */
function assertCoordinationTask(
  manifest: RunManifest,
  taskId: string,
  path: string,
): void {
  if (!manifest.graph.tasks.some((task) => task.id === taskId)) {
    invalidRecord(path, "coordination record names a task outside its run");
  }
}

export async function publishRunEvent(
  stateRoot: string,
  runId: string,
  input: PublishRunEvent,
): Promise<RunEventRecord> {
  const event = parsePublishRunEvent(input);
  return withActiveRunPublication(
    stateRoot,
    runId,
    event.taskId,
    async (manifest, task) => {
      for (const recipient of event.recipients ?? []) {
        findTask(manifest, recipient);
      }
      const record = await publishCoordinationRecord<RunEventRecord>(
        stateRoot,
        runId,
        (eventId) => ({
          schemaVersion: SCHEMA_VERSION,
          kind: "run-event",
          eventId,
          runId,
          taskId: task.id,
          eventKind: event.eventKind,
          timestamp: new Date().toISOString(),
          message: event.message,
          ...(event.paths === undefined ? {} : { paths: event.paths }),
          ...(event.symbols === undefined ? {} : { symbols: event.symbols }),
          ...(event.recipients === undefined
            ? {}
            : { recipients: event.recipients }),
        }),
      );
      return Object.freeze(record);
    },
  );
}

export async function readRunEvents(
  stateRoot: string,
  runId: string,
  options?: RunEventQuery,
): Promise<RunEventQueryResult> {
  const manifest = await readRun(stateRoot, runId);
  const query = parseRunEventQuery(options);
  const entries = await coordinationEntries(
    stateRoot,
    manifest.runId,
    query.cursor,
  );
  const page = await readCoordinationPage(
    entries,
    query.limit ?? RUN_COORDINATION_MAX_READ,
    async (entry) => {
      const value = await readJson(entry.path);
      if (coordinationRecordKind(value, entry.path) !== "run-event") {
        return undefined;
      }
      const record = validateRunEvent(value, entry.path);
      if (record.eventId !== entry.id || record.runId !== manifest.runId) {
        return invalidRecord(
          entry.path,
          "run event identity does not match its path",
        );
      }
      assertCoordinationTask(manifest, record.taskId, entry.path);
      const matches =
        (query.eventKind === undefined ||
          record.eventKind === query.eventKind) &&
        (query.recipient === undefined ||
          record.recipients?.includes(query.recipient) === true) &&
        (query.path === undefined ||
          record.paths?.includes(query.path) === true) &&
        (query.symbol === undefined ||
          record.symbols?.includes(query.symbol) === true);
      return matches ? record : undefined;
    },
  );
  return page.nextCursor === undefined
    ? { events: Object.freeze(page.records) }
    : { events: Object.freeze(page.records), nextCursor: page.nextCursor };
}

export async function sendRunMessage(
  stateRoot: string,
  runId: string,
  input: PublishRunMessage,
): Promise<RunMessageRecord> {
  const message = parsePublishRunMessage(input);
  return withActiveRunPublication(
    stateRoot,
    runId,
    message.senderTaskId,
    async (manifest, sender) => {
      const recipient = findTask(manifest, message.recipientTaskId);
      const record = await publishCoordinationRecord<RunMessageRecord>(
        stateRoot,
        runId,
        (messageId) => ({
          schemaVersion: SCHEMA_VERSION,
          kind: "run-message",
          messageId,
          runId,
          senderTaskId: sender.id,
          recipientTaskId: recipient.id,
          timestamp: new Date().toISOString(),
          message: message.message,
        }),
      );
      return Object.freeze(record);
    },
  );
}

export async function readRunMessages(
  stateRoot: string,
  runId: string,
  recipientTaskId: string,
  options?: RunMessageQuery,
): Promise<RunMessageQueryResult> {
  const manifest = await readRun(stateRoot, runId);
  const recipient = findTask(manifest, recipientTaskId);
  const query = parseRunMessageQuery(options);
  const entries = await coordinationEntries(
    stateRoot,
    manifest.runId,
    query.cursor,
  );
  const page = await readCoordinationPage(
    entries,
    query.limit ?? RUN_COORDINATION_MAX_READ,
    async (entry) => {
      const value = await readJson(entry.path);
      if (coordinationRecordKind(value, entry.path) !== "run-message") {
        return undefined;
      }
      const record = validateRunMessage(value, entry.path);
      if (record.messageId !== entry.id || record.runId !== manifest.runId) {
        return invalidRecord(
          entry.path,
          "run message identity does not match its path",
        );
      }
      assertCoordinationTask(manifest, record.senderTaskId, entry.path);
      assertCoordinationTask(manifest, record.recipientTaskId, entry.path);
      // An inbox is bound to the reading worker, so a record addressed to
      // another task is skipped rather than refused.
      return record.recipientTaskId === recipient.id ? record : undefined;
    },
  );
  return page.nextCursor === undefined
    ? { messages: Object.freeze(page.records) }
    : { messages: Object.freeze(page.records), nextCursor: page.nextCursor };
}

/**
 * Reads the retained text artifact of a task's current attempt.
 *
 * The artifact is only readable through the output that claims it, and only
 * while that output itself agrees with the node's current state: an artifact
 * left behind by an interrupted publication has no reference vouching for it,
 * and is reported as inconsistent rather than returned as if it were current.
 */
export async function readNodeArtifact(
  stateRoot: string,
  runId: string,
  taskId: string,
): Promise<NodeArtifactRecord> {
  const manifest = await readRun(stateRoot, runId);
  const task = findTask(manifest, taskId);
  const [record, output] = await Promise.all([
    readNodeArtifactRecord(stateRoot, manifest, task),
    readNodeOutput(stateRoot, runId, taskId),
  ]);
  if (
    output.artifact === undefined ||
    record.attempt !== output.attempt ||
    output.artifact.bytes !== Buffer.byteLength(record.text, "utf8")
  ) {
    throw new RunStoreError(
      "invalid_record",
      "Node artifact does not match the published node output",
      artifactPath(stateRoot, runId, task.key),
    );
  }
  return record;
}

/**
 * How well one task's spend is known.
 *
 * `not_started` is not a gap in the accounting: a task that never ran spent
 * nothing. `unreported` is a gap: the attempt happened and nothing recorded
 * what it cost, which must never read as work that was free.
 */
export type RunTaskAccounting = "reported" | "unreported" | "not_started";

export interface RunTaskUsage {
  readonly taskId: string;
  readonly status: NodeStatus;
  readonly accounting: RunTaskAccounting;
  readonly usage: TaskUsage | undefined;
}

export interface RunUsage {
  readonly runId: string;
  /**
   * The sum across the run's attempts. `TASK_USAGE_LIMITS` bounds one
   * attempt, not this: a 32-task run can legitimately total beyond them, so
   * this is not a value `parseTaskUsage` would accept back.
   */
  readonly total: TaskUsage;
  /** Tasks that ran and recorded no usage, in manifest order. */
  readonly unaccounted: readonly string[];
  readonly tasks: readonly RunTaskUsage[];
}

function addUsage(total: TaskUsage, usage: TaskUsage): TaskUsage {
  return {
    turns: total.turns + usage.turns,
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

/**
 * Sums what one retained run spent, from the outputs it published.
 *
 * Derived rather than stored, so it is correct for a run that was interrupted
 * and needs no record kept in step with the outputs. A task with no readable
 * output contributes nothing and is named in `unaccounted`: an unknown total
 * must not read as a cheap one.
 */
export async function readRunUsage(
  stateRoot: string,
  runId: string,
): Promise<RunUsage> {
  const manifest = await readRun(stateRoot, runId);
  const tasks: RunTaskUsage[] = [];
  const unaccounted: string[] = [];
  let total: TaskUsage = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const task of manifest.graph.tasks) {
    const state = await readNodeStateRecord(stateRoot, manifest, task);
    let usage: TaskUsage | undefined;
    let published = true;
    try {
      const record = await readNodeOutputRecord(stateRoot, manifest, task);
      // The same agreement every other reader requires. A malformed or
      // inconsistent record is reported, not quietly counted as nothing:
      // only a task that published no output at all is an expected absence.
      assertOutputMatchesState(record, state);
      usage = record.usage;
    } catch (error) {
      if (!(error instanceof RunStoreError) || error.code !== "not_found") {
        throw error;
      }
      published = false;
    }
    const accounting: RunTaskAccounting =
      usage !== undefined
        ? "reported"
        : !published &&
            (state.status === "pending" || state.status === "blocked")
          ? "not_started"
          : "unreported";
    if (accounting === "unreported") unaccounted.push(task.id);
    if (usage !== undefined) total = addUsage(total, usage);
    tasks.push(
      Object.freeze({
        taskId: task.id,
        status: state.status,
        accounting,
        usage,
      }),
    );
  }
  return Object.freeze({
    runId: manifest.runId,
    total: Object.freeze({ ...total, cost: Object.freeze({ ...total.cost }) }),
    unaccounted: Object.freeze(unaccounted),
    tasks: Object.freeze(tasks),
  });
}

/**
 * Every reader of a published output applies this: an output for a different
 * attempt, for a node settled as blocked, or disagreeing with a terminal node
 * status describes state no reader may act on.
 */
function assertOutputMatchesState(
  record: NodeOutputRecord,
  state: NodeStateRecord,
): void {
  if (
    record.attempt !== state.attempt ||
    state.status === "blocked" ||
    (OUTPUT_STATUSES.has(state.status as NodeOutputStatus) &&
      record.status !== state.status)
  ) {
    throw new RunStoreError(
      "invalid_record",
      "Node output does not match current node state",
    );
  }
}

export async function readNodeOutput(
  stateRoot: string,
  runId: string,
  taskId: string,
): Promise<NodeOutputRecord> {
  const manifest = await readRun(stateRoot, runId);
  const task = findTask(manifest, taskId);
  const [record, state] = await Promise.all([
    readNodeOutputRecord(stateRoot, manifest, task),
    readNodeStateRecord(stateRoot, manifest, task),
  ]);
  assertOutputMatchesState(record, state);
  return record;
}
