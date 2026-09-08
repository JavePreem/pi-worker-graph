import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadWorkerGraphConfiguration,
  type WorkerGraphConfiguration,
} from "./config.js";
import type {
  PiSubprocessExecutorOptions,
  PiWorkerProgress,
  PiWorkerTaskPayload,
  PiWorkerUsage,
} from "./pi-subprocess.js";
import { createPiSubprocessExecutor } from "./pi-subprocess.js";
import type { GraphRunResult, RunGraphOptions, TaskExecutor } from "./run.js";
import { RUN_GRAPH_LIMITS, runGraph } from "./run.js";

export const WORKER_GRAPH_TOOL_NAME = "worker_graph";

const MAX_ID_BYTES = 256;
const MAX_ASSIGNMENT_BYTES = 48 * 1024;
const MAX_ITEM_BYTES = 16 * 1024;
const MAX_EXPECTED_PATH_BYTES = 4 * 1024;
const MAX_PROFILE_BYTES = 256;
const MAX_TOOL_UPDATES = 256;

const TOOL_FIELDS = new Set(["tasks", "concurrency", "taskTimeoutMs"]);
const TASK_FIELDS = new Set([
  "id",
  "needs",
  "profile",
  "assignment",
  "acceptanceCriteria",
  "expectedPaths",
]);

// JSON Schema counts characters while the defensive parser counts UTF-8 bytes.
// Keep the schema as a coarse bound and tell the model which limit is real.
const boundedString = (description: string, maxLength: number) =>
  Type.String({
    minLength: 1,
    maxLength,
    description: `${description} At most ${maxLength} bytes of UTF-8.`,
  });

const workerTaskSchema = Type.Object(
  {
    id: boundedString("Unique task ID.", MAX_ID_BYTES),
    needs: Type.Optional(
      Type.Array(boundedString("Direct prerequisite task ID.", MAX_ID_BYTES), {
        maxItems: RUN_GRAPH_LIMITS.maxDependenciesPerTask,
      }),
    ),
    profile: boundedString(
      "Explicit worker profile name from the global worker-graph configuration.",
      MAX_PROFILE_BYTES,
    ),
    assignment: boundedString(
      "Self-contained assignment for this worker.",
      MAX_ASSIGNMENT_BYTES,
    ),
    acceptanceCriteria: Type.Optional(
      Type.Array(boundedString("One acceptance criterion.", MAX_ITEM_BYTES), {
        maxItems: 32,
      }),
    ),
    expectedPaths: Type.Optional(
      Type.Array(
        boundedString(
          "One repository-relative path the worker is expected to inspect or change.",
          MAX_EXPECTED_PATH_BYTES,
        ),
        { maxItems: 32 },
      ),
    ),
  },
  { additionalProperties: false },
);

const workerGraphSchema = Type.Object(
  {
    tasks: Type.Array(workerTaskSchema, {
      minItems: 1,
      maxItems: RUN_GRAPH_LIMITS.maxTasks,
    }),
    concurrency: Type.Optional(
      Type.Integer({ minimum: 1, maximum: RUN_GRAPH_LIMITS.maxConcurrency }),
    ),
    taskTimeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: RUN_GRAPH_LIMITS.maxTaskRuntimeMs,
      }),
    ),
  },
  { additionalProperties: false },
);

interface WorkerGraphToolTask {
  readonly id: string;
  readonly needs?: readonly string[];
  readonly profile: string;
  readonly assignment: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly expectedPaths?: readonly string[];
}

interface WorkerGraphToolRequest {
  readonly tasks: readonly WorkerGraphToolTask[];
  readonly concurrency?: number;
  readonly taskTimeoutMs?: number;
}

export interface WorkerGraphOrchestratorDependencies {
  readonly getAgentDirectory: () => string;
  readonly loadConfiguration?: (
    options: Parameters<typeof loadWorkerGraphConfiguration>[0],
  ) => Promise<WorkerGraphConfiguration>;
  readonly createExecutor?: (
    options: PiSubprocessExecutorOptions,
  ) => TaskExecutor;
  readonly executeGraph?: (
    options: RunGraphOptions<PiWorkerTaskPayload>,
  ) => Promise<GraphRunResult>;
}

function invalidRequest(): never {
  throw new Error("Invalid worker_graph request");
}

function exactFields(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidRequest();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.size) return invalidRequest();
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return invalidRequest();
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function arrayItems(value: unknown, maximumItems: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return invalidRequest();
  }
  const length = value.length;
  if (length > maximumItems) return invalidRequest();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    return invalidRequest();
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return invalidRequest();
    }
    items.push(descriptor.value);
  }
  return items;
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value) > maximum
  ) {
    return invalidRequest();
  }
  return value;
}

function stringList(
  value: unknown,
  maximumItems: number,
  maximumBytes: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return Object.freeze(
    arrayItems(value, maximumItems).map((item) => text(item, maximumBytes)),
  );
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return invalidRequest();
  }
  return value as number;
}

function parseWorkerGraphRequest(value: unknown): WorkerGraphToolRequest {
  const fields = exactFields(value, TOOL_FIELDS);
  const taskItems = arrayItems(fields.tasks, RUN_GRAPH_LIMITS.maxTasks);
  if (taskItems.length === 0) return invalidRequest();
  const tasks = Object.freeze(
    taskItems.map((candidate) => {
      const task = exactFields(candidate, TASK_FIELDS);
      const needs = stringList(
        task.needs,
        RUN_GRAPH_LIMITS.maxDependenciesPerTask,
        MAX_ID_BYTES,
      );
      const acceptanceCriteria = stringList(
        task.acceptanceCriteria,
        32,
        MAX_ITEM_BYTES,
      );
      const expectedPaths = stringList(
        task.expectedPaths,
        32,
        MAX_EXPECTED_PATH_BYTES,
      );
      return Object.freeze({
        id: text(task.id, MAX_ID_BYTES),
        profile: text(task.profile, MAX_PROFILE_BYTES),
        assignment: text(task.assignment, MAX_ASSIGNMENT_BYTES),
        ...(needs === undefined ? {} : { needs }),
        ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
        ...(expectedPaths === undefined ? {} : { expectedPaths }),
      });
    }),
  );
  const concurrency = positiveInteger(
    fields.concurrency,
    RUN_GRAPH_LIMITS.maxConcurrency,
  );
  const taskTimeoutMs = positiveInteger(
    fields.taskTimeoutMs,
    RUN_GRAPH_LIMITS.maxTaskRuntimeMs,
  );
  return Object.freeze({
    tasks,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
  });
}

function aggregateUsage(
  updates: ReadonlyMap<string, PiWorkerProgress>,
): PiWorkerUsage {
  const total = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const update of updates.values()) {
    total.turns += update.usage.turns;
    total.input += update.usage.input;
    total.output += update.usage.output;
    total.cacheRead += update.usage.cacheRead;
    total.cacheWrite += update.usage.cacheWrite;
    total.totalTokens += update.usage.totalTokens;
    total.cost.input += update.usage.cost.input;
    total.cost.output += update.usage.cost.output;
    total.cost.cacheRead += update.usage.cost.cacheRead;
    total.cost.cacheWrite += update.usage.cost.cacheWrite;
    total.cost.total += update.usage.cost.total;
  }
  return total;
}

function piUsage(usage: PiWorkerUsage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function progressText(
  taskCount: number,
  updates: ReadonlyMap<string, PiWorkerProgress>,
): string {
  const completed = [...updates.values()].filter(
    (update) => update.phase === "finished",
  ).length;
  const lines = [...updates.values()]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((update) => {
      const detail = update.tool ?? update.status;
      return `${update.taskId}: ${update.phase}${detail ? ` (${detail})` : ""}`;
    });
  return [
    `Worker graph running: ${completed}/${taskCount} complete`,
    ...lines,
  ].join("\n");
}

function finalText(result: GraphRunResult): string {
  return [
    `Worker graph ${result.status}. Run ID: ${result.runId}`,
    ...result.nodes.map((node) => `${node.taskId}: ${node.status}`),
  ].join("\n");
}

export function registerWorkerGraphOrchestratorTool(
  pi: ExtensionAPI,
  dependencies: WorkerGraphOrchestratorDependencies,
): void {
  const loadConfiguration =
    dependencies.loadConfiguration ?? loadWorkerGraphConfiguration;
  const createExecutor =
    dependencies.createExecutor ?? createPiSubprocessExecutor;
  const executeGraph = dependencies.executeGraph ?? runGraph;

  pi.registerTool({
    name: WORKER_GRAPH_TOOL_NAME,
    label: "Worker Graph",
    description:
      "Run a fully specified dependency graph of bounded writable workers in the current checkout.",
    promptSnippet: "Run an explicit dependency graph of writable workers",
    promptGuidelines: [
      "Use worker_graph only when worker-graph mode is explicitly enabled.",
      "Give each worker_graph task a narrow assignment and explicit dependencies; only independent tasks should overlap.",
      "After worker_graph completes, review the actual shared checkout and run final validation before accepting the work.",
    ],
    parameters: workerGraphSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request = parseWorkerGraphRequest(params);
      const configuration = await loadConfiguration({
        agentDirectory: dependencies.getAgentDirectory(),
        workingDirectory: ctx.cwd,
      });
      const updates = new Map<string, PiWorkerProgress>();
      let emittedUpdates = 0;
      const executor = createExecutor({
        profiles: configuration.profiles,
        onProgress(progress) {
          updates.set(progress.taskId, progress);
          if (emittedUpdates >= MAX_TOOL_UPDATES) return;
          emittedUpdates += 1;
          const usage = aggregateUsage(updates);
          onUpdate?.({
            content: [
              {
                type: "text",
                text: progressText(request.tasks.length, updates),
              },
            ],
            details: {
              kind: "worker-graph-progress",
              tasks: [...updates.values()],
              usage,
            },
          });
        },
      });
      const graph = {
        tasks: request.tasks.map((task) => ({
          id: task.id,
          ...(task.needs === undefined ? {} : { needs: task.needs }),
          payload: {
            profile: task.profile,
            assignment: task.assignment,
            ...(task.acceptanceCriteria === undefined
              ? {}
              : { acceptanceCriteria: task.acceptanceCriteria }),
            ...(task.expectedPaths === undefined
              ? {}
              : { expectedPaths: task.expectedPaths }),
          },
        })),
        ...(request.concurrency === undefined
          ? {}
          : { concurrency: request.concurrency }),
      };
      const result = await executeGraph({
        stateRoot: configuration.stateRoot,
        workingDirectory: ctx.cwd,
        graph,
        executor,
        ...(signal === undefined ? {} : { signal }),
        ...(request.taskTimeoutMs === undefined
          ? {}
          : { taskTimeoutMs: request.taskTimeoutMs }),
      });
      const usage = aggregateUsage(updates);
      return {
        content: [{ type: "text", text: finalText(result) }],
        details: {
          kind: "worker-graph-result",
          runId: result.runId,
          status: result.status,
          nodes: result.nodes.map((node) => ({
            taskId: node.taskId,
            status: node.status,
          })),
          usage,
        },
        usage: piUsage(usage),
      };
    },
  });
}
