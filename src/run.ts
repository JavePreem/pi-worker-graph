import { resolve } from "node:path";
import type { GraphRequest, GraphState, NormalizedGraph } from "./graph.js";
import {
  createInitialState,
  isGraphComplete,
  normalizeGraph,
  readyFrontier,
  setNodeStatus,
  settleBlocked,
} from "./graph.js";
import type { JsonValue } from "./json.js";
import { isJsonValue, jsonByteLength } from "./json.js";
import type { NodeOutput } from "./output.js";
import { parseNodeDiagnostics, parseNodeOutput } from "./output.js";
import type { NodeStateRecord, RunManifest } from "./store.js";
import {
  createRun,
  publishNodeOutput,
  readNodeOutput,
  readNodeState,
  readRun,
  writeNodeState,
} from "./store.js";

export const RUN_GRAPH_LIMITS = Object.freeze({
  maxTasks: 32,
  maxDependenciesPerTask: 8,
  maxConcurrency: 8,
  maxPayloadBytes: 64 * 1024,
  maxOutputBytes: 128 * 1024,
  maxPrerequisiteBytes: 256 * 1024,
  maxTaskRuntimeMs: 10 * 60 * 1000,
});

export type RunGraphIssueCode =
  | "invalid_working_directory"
  | "invalid_task_timeout"
  | "task_limit"
  | "dependency_limit"
  | "concurrency_limit"
  | "invalid_payload"
  | "payload_limit";

export interface RunGraphIssue {
  readonly code: RunGraphIssueCode;
  readonly message: string;
  readonly taskId?: string;
}

export class RunGraphValidationError extends Error {
  readonly issues: readonly RunGraphIssue[];

  constructor(issues: readonly RunGraphIssue[]) {
    super(
      `Invalid graph run: ${issues.map((issue) => issue.message).join("; ")}`,
    );
    this.name = "RunGraphValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export interface PrerequisiteOutput {
  readonly taskId: string;
  readonly output: NodeOutput;
}

export interface TaskExecutionInput {
  readonly runId: string;
  readonly taskId: string;
  readonly payload: JsonValue | undefined;
  readonly workingDirectory: string;
  readonly prerequisites: readonly PrerequisiteOutput[];
  readonly signal: AbortSignal;
}

export interface TaskExecutionResult {
  readonly output: NodeOutput;
  readonly diagnostics?: string;
}

/**
 * Executors must stop all underlying work promptly when `input.signal` aborts.
 * Ignoring the signal violates the adapter contract and may allow work to outlive
 * the graph run.
 */
export type TaskExecutor = (
  input: TaskExecutionInput,
) => Promise<TaskExecutionResult>;

export interface RunGraphOptions<TPayload = unknown> {
  readonly stateRoot: string;
  readonly graph: GraphRequest<TPayload>;
  readonly workingDirectory: string;
  readonly executor: TaskExecutor;
  readonly signal?: AbortSignal;
  readonly taskTimeoutMs?: number;
}

export type GraphRunStatus = "succeeded" | "failed" | "aborted";

export interface GraphRunResult {
  readonly runId: string;
  readonly status: GraphRunStatus;
  readonly nodes: readonly NodeStateRecord[];
}

type SettledTask =
  | {
      readonly taskId: string;
      readonly status: "succeeded";
      readonly output: NodeOutput;
      readonly diagnostics?: string;
    }
  | {
      readonly taskId: string;
      readonly status: "failed";
      readonly output?: NodeOutput;
      readonly diagnostics?: string;
    }
  | {
      readonly taskId: string;
      readonly status: "aborted";
      readonly diagnostics?: string;
    };

function validateRun<TPayload>(
  graph: GraphRequest<TPayload>,
  workingDirectory: string,
  taskTimeoutMs: number,
): readonly RunGraphIssue[] {
  const issues: RunGraphIssue[] = [];
  if (workingDirectory.trim().length === 0) {
    issues.push({
      code: "invalid_working_directory",
      message: "Working directory must not be empty",
    });
  }
  if (
    !Number.isInteger(taskTimeoutMs) ||
    taskTimeoutMs <= 0 ||
    taskTimeoutMs > RUN_GRAPH_LIMITS.maxTaskRuntimeMs
  ) {
    issues.push({
      code: "invalid_task_timeout",
      message: `Task timeout must be a positive integer no greater than ${RUN_GRAPH_LIMITS.maxTaskRuntimeMs}`,
    });
  }
  if (graph.tasks.length > RUN_GRAPH_LIMITS.maxTasks) {
    issues.push({
      code: "task_limit",
      message: `Graph has ${graph.tasks.length} tasks; limit is ${RUN_GRAPH_LIMITS.maxTasks}`,
    });
  }
  if (
    graph.concurrency !== undefined &&
    graph.concurrency > RUN_GRAPH_LIMITS.maxConcurrency
  ) {
    issues.push({
      code: "concurrency_limit",
      message: `Concurrency ${graph.concurrency} exceeds limit ${RUN_GRAPH_LIMITS.maxConcurrency}`,
    });
  }
  if (graph.tasks.length > RUN_GRAPH_LIMITS.maxTasks) return issues;

  for (const task of graph.tasks) {
    if ((task.needs?.length ?? 0) > RUN_GRAPH_LIMITS.maxDependenciesPerTask) {
      issues.push({
        code: "dependency_limit",
        taskId: task.id,
        message: `Task ${JSON.stringify(task.id)} has too many dependencies`,
      });
    }
    if (task.payload === undefined) continue;
    if (!isJsonValue(task.payload)) {
      issues.push({
        code: "invalid_payload",
        taskId: task.id,
        message: `Task ${JSON.stringify(task.id)} payload is not a JSON value`,
      });
      continue;
    }
    try {
      if (jsonByteLength(task.payload) > RUN_GRAPH_LIMITS.maxPayloadBytes) {
        issues.push({
          code: "payload_limit",
          taskId: task.id,
          message: `Task ${JSON.stringify(task.id)} payload exceeds ${RUN_GRAPH_LIMITS.maxPayloadBytes} bytes`,
        });
      }
    } catch {
      issues.push({
        code: "invalid_payload",
        taskId: task.id,
        message: `Task ${JSON.stringify(task.id)} payload cannot be serialized safely`,
      });
    }
  }
  return issues;
}

function invalidExecutorResult(taskId: string): SettledTask {
  return {
    taskId,
    status: "failed",
    diagnostics: "Task executor returned an invalid or oversized result",
  };
}

function validateExecutorResult(taskId: string, value: unknown): SettledTask {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalidExecutorResult(taskId);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidExecutorResult(taskId);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length === 0 ||
      keys.length > 2 ||
      !keys.includes("output") ||
      !keys.every(
        (key) =>
          typeof key === "string" &&
          (key === "output" || key === "diagnostics"),
      )
    ) {
      return invalidExecutorResult(taskId);
    }
    const outputDescriptor = Object.getOwnPropertyDescriptor(value, "output");
    const diagnosticsDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "diagnostics",
    );
    if (
      outputDescriptor === undefined ||
      !outputDescriptor.enumerable ||
      !("value" in outputDescriptor) ||
      (diagnosticsDescriptor !== undefined &&
        (!diagnosticsDescriptor.enumerable ||
          !("value" in diagnosticsDescriptor)))
    ) {
      return invalidExecutorResult(taskId);
    }

    const output = parseNodeOutput(outputDescriptor.value);
    const diagnostics = parseNodeDiagnostics(diagnosticsDescriptor?.value);
    const boundedValue = {
      output,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
    if (
      jsonByteLength(boundedValue as unknown as JsonValue) >
      RUN_GRAPH_LIMITS.maxOutputBytes
    ) {
      return invalidExecutorResult(taskId);
    }
    return output.blockers.length > 0
      ? {
          taskId,
          status: "failed",
          ...boundedValue,
        }
      : {
          taskId,
          status: "succeeded",
          ...boundedValue,
        };
  } catch {
    return invalidExecutorResult(taskId);
  }
}

function executeTask(
  executor: TaskExecutor,
  input: Omit<TaskExecutionInput, "signal">,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<SettledTask> {
  return new Promise((resolveTask) => {
    const controller = new AbortController();
    const executionInput: TaskExecutionInput = {
      ...input,
      signal: controller.signal,
    };
    let settled = false;
    let timedOut = false;
    const parentAbort = () => controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const settle = (result: SettledTask) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", parentAbort);
      controller.signal.removeEventListener("abort", abort);
      resolveTask(result);
    };
    const abort = () => {
      settle(
        timedOut
          ? {
              taskId: input.taskId,
              status: "failed",
              diagnostics: "Task executor timed out",
            }
          : {
              taskId: input.taskId,
              status: "aborted",
              diagnostics: "Graph run was aborted",
            },
      );
    };

    controller.signal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) {
      parentAbort();
      return;
    }
    parentSignal.addEventListener("abort", parentAbort, { once: true });
    Promise.resolve()
      .then(() => executor(executionInput))
      .then(
        (result) => settle(validateExecutorResult(input.taskId, result)),
        () => {
          settle({
            taskId: input.taskId,
            status: "failed",
            diagnostics: "Task executor failed",
          });
        },
      );
  });
}

async function prerequisiteOutputs(
  stateRoot: string,
  manifest: RunManifest,
  taskId: string,
): Promise<readonly PrerequisiteOutput[]> {
  const task = manifest.graph.tasks.find(
    (candidate) => candidate.id === taskId,
  );
  if (!task) throw new Error(`Unknown task ${JSON.stringify(taskId)}`);

  return Promise.all(
    task.needs.map(async (dependency) => {
      const record = await readNodeOutput(
        stateRoot,
        manifest.runId,
        dependency,
      );
      if (record.status !== "succeeded") {
        throw new Error(
          `Prerequisite ${JSON.stringify(dependency)} did not succeed`,
        );
      }
      return {
        taskId: dependency,
        output: record.output,
      };
    }),
  );
}

async function settlePersistedBlocked(
  stateRoot: string,
  runId: string,
  graph: NormalizedGraph<JsonValue>,
  state: GraphState,
): Promise<GraphState> {
  const settled = settleBlocked(graph, state);
  for (const task of graph.tasks) {
    if (
      state.get(task.id) === "pending" &&
      settled.get(task.id) === "blocked"
    ) {
      await writeNodeState(stateRoot, runId, task.id, "blocked");
    }
  }
  return settled;
}

async function persistCompletion(
  stateRoot: string,
  runId: string,
  completion: SettledTask,
): Promise<void> {
  await publishNodeOutput(
    stateRoot,
    runId,
    completion.status === "succeeded"
      ? {
          taskId: completion.taskId,
          status: completion.status,
          output: completion.output,
          ...(completion.diagnostics === undefined
            ? {}
            : { diagnostics: completion.diagnostics }),
        }
      : completion.status === "failed"
        ? {
            taskId: completion.taskId,
            status: completion.status,
            ...(completion.output === undefined
              ? {}
              : { output: completion.output }),
            ...(completion.diagnostics === undefined
              ? {}
              : { diagnostics: completion.diagnostics }),
          }
        : {
            taskId: completion.taskId,
            status: completion.status,
            ...(completion.diagnostics === undefined
              ? {}
              : { diagnostics: completion.diagnostics }),
          },
  );
  await writeNodeState(stateRoot, runId, completion.taskId, completion.status);
}

async function abortPending(
  stateRoot: string,
  runId: string,
  graph: NormalizedGraph<JsonValue>,
  initialState: GraphState,
): Promise<GraphState> {
  let state = await settlePersistedBlocked(
    stateRoot,
    runId,
    graph,
    initialState,
  );
  while (!isGraphComplete(graph, state)) {
    const ready = readyFrontier(graph, state);
    if (ready.length === 0) {
      throw new Error("Graph has pending tasks but no abortable frontier");
    }
    for (const taskId of ready) {
      await persistCompletion(stateRoot, runId, {
        taskId,
        status: "aborted",
        diagnostics: "Graph run was aborted before task execution",
      });
      state = setNodeStatus(graph, state, taskId, "aborted");
    }
    state = await settlePersistedBlocked(stateRoot, runId, graph, state);
  }
  return state;
}

function aggregateStatus(nodes: readonly NodeStateRecord[]): GraphRunStatus {
  if (nodes.some((node) => node.status === "aborted")) return "aborted";
  if (nodes.some((node) => node.status !== "succeeded")) return "failed";
  return "succeeded";
}

export async function runGraph<TPayload>(
  options: RunGraphOptions<TPayload>,
): Promise<GraphRunResult> {
  const taskTimeoutMs =
    options.taskTimeoutMs ?? RUN_GRAPH_LIMITS.maxTaskRuntimeMs;
  const issues = validateRun(
    options.graph,
    options.workingDirectory,
    taskTimeoutMs,
  );
  if (issues.length > 0) throw new RunGraphValidationError(issues);
  const graph = normalizeGraph(options.graph);

  const workingDirectory = resolve(options.workingDirectory);
  const created = await createRun(options.stateRoot, graph);
  const manifest = await readRun(options.stateRoot, created.runId);
  const persistedGraph = normalizeGraph({
    tasks: manifest.graph.tasks.map((task) => ({
      id: task.id,
      needs: task.needs,
      ...(task.payload === undefined ? {} : { payload: task.payload }),
    })),
    ...(manifest.graph.concurrency === undefined
      ? {}
      : { concurrency: manifest.graph.concurrency }),
  });
  const concurrency = persistedGraph.concurrency ?? 1;
  const runController = new AbortController();
  const abortRun = () => runController.abort();
  if (options.signal?.aborted) abortRun();
  else options.signal?.addEventListener("abort", abortRun, { once: true });
  const signal = runController.signal;
  const running = new Map<string, Promise<SettledTask>>();
  let state = createInitialState(persistedGraph);

  try {
    while (!isGraphComplete(persistedGraph, state)) {
      if (!signal.aborted) {
        const available = concurrency - running.size;
        const ready = readyFrontier(persistedGraph, state).slice(0, available);
        for (const taskId of ready) {
          if (signal.aborted) break;
          const task = manifest.graph.tasks.find(
            (candidate) => candidate.id === taskId,
          );
          if (!task) throw new Error(`Unknown task ${JSON.stringify(taskId)}`);
          const prerequisites = await prerequisiteOutputs(
            options.stateRoot,
            manifest,
            taskId,
          );
          const contextValue = prerequisites.map((prerequisite) => ({
            taskId: prerequisite.taskId,
            output: prerequisite.output,
          })) as unknown as JsonValue;
          const contextTooLarge =
            jsonByteLength(contextValue) >
            RUN_GRAPH_LIMITS.maxPrerequisiteBytes;

          await writeNodeState(
            options.stateRoot,
            manifest.runId,
            taskId,
            "running",
          );
          state = setNodeStatus(persistedGraph, state, taskId, "running");
          running.set(
            taskId,
            signal.aborted
              ? Promise.resolve({
                  taskId,
                  status: "aborted",
                  diagnostics: "Graph run was aborted",
                })
              : contextTooLarge
                ? Promise.resolve({
                    taskId,
                    status: "failed",
                    diagnostics:
                      "Direct prerequisite output exceeds context limit",
                  })
                : executeTask(
                    options.executor,
                    {
                      runId: manifest.runId,
                      taskId,
                      payload: task.payload,
                      workingDirectory,
                      prerequisites,
                    },
                    signal,
                    taskTimeoutMs,
                  ),
          );
        }
      }

      if (running.size === 0) {
        if (signal.aborted) {
          state = await abortPending(
            options.stateRoot,
            manifest.runId,
            persistedGraph,
            state,
          );
          break;
        }
        state = await settlePersistedBlocked(
          options.stateRoot,
          manifest.runId,
          persistedGraph,
          state,
        );
        if (!isGraphComplete(persistedGraph, state)) {
          throw new Error("Graph made no scheduling progress");
        }
        break;
      }

      const completion = await Promise.race(running.values());
      running.delete(completion.taskId);
      await persistCompletion(options.stateRoot, manifest.runId, completion);
      state = setNodeStatus(
        persistedGraph,
        state,
        completion.taskId,
        completion.status,
      );
      state = await settlePersistedBlocked(
        options.stateRoot,
        manifest.runId,
        persistedGraph,
        state,
      );
    }
  } catch (error) {
    abortRun();
    await Promise.allSettled(running.values());
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortRun);
  }

  const nodes = await Promise.all(
    persistedGraph.tasks.map((task) =>
      readNodeState(options.stateRoot, manifest.runId, task.id),
    ),
  );
  return {
    runId: manifest.runId,
    status: aggregateStatus(nodes),
    nodes,
  };
}
