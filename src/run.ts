import { resolve } from "node:path";
import type { PrerequisiteOutput } from "./context.js";
import {
  PrerequisiteContextOverflowError,
  serializePrerequisiteReports,
} from "./context.js";
import {
  taskExecutionDiagnostics,
  taskExecutionFailureTaskId,
  taskExecutionUsage,
} from "./execution-failure.js";
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
import {
  parseNodeArtifact,
  parseNodeDiagnostics,
  parseNodeOutput,
} from "./output.js";
import type { NodeStateRecord, RunManifest, RunOwnership } from "./store.js";
import {
  acquireRunOwnership,
  createRun,
  publishNodeOutput,
  RUN_STORE_DEFAULT_MAX_RUNS,
  RUN_STORE_MAX_RUNS,
  RunStoreError,
  readNodeOutput,
  readNodeState,
  readRun,
  recoverRunMutationLock,
  releaseRunOwnership,
  writeNodeState,
} from "./store.js";
import type { TaskUsage } from "./usage.js";
import { parseTaskUsage } from "./usage.js";

/**
 * Attempts the parent makes at one store mutation when the run mutation lock
 * is busy. Workers take the same lock to publish coordination records, so a
 * parent mutation has to outlast ordinary contention; each attempt waits out
 * the store's own lock deadline before giving up.
 */
const MUTATION_LOCK_ATTEMPTS = 4;

export const RUN_GRAPH_LIMITS = Object.freeze({
  maxTasks: 32,
  maxDependenciesPerTask: 8,
  maxConcurrency: 8,
  maxPayloadBytes: 64 * 1024,
  maxOutputBytes: 128 * 1024,
  maxPrerequisiteBytes: 256 * 1024,
  maxTaskRuntimeMs: 10 * 60 * 1000,
  maxExecutorCleanupMs: 5_000,
  maxRetainedRuns: RUN_STORE_MAX_RUNS,
});

export type RunGraphIssueCode =
  | "invalid_working_directory"
  | "invalid_task_timeout"
  | "invalid_retention_limit"
  | "task_limit"
  | "dependency_limit"
  | "concurrency_limit"
  | "invalid_payload"
  | "payload_limit"
  | "adapter_validation";

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

export interface TaskExecutionInput {
  readonly runId: string;
  readonly taskId: string;
  readonly payload: JsonValue | undefined;
  readonly workingDirectory: string;
  readonly prerequisites: readonly PrerequisiteOutput[];
  /** Canonical, byte-bounded prompt context for the direct prerequisites. */
  readonly prerequisiteContext: string;
  /** Present for adapters that expose run-scoped coordination to workers. */
  readonly runStateRoot?: string;
  readonly signal: AbortSignal;
}

export interface TaskExecutionResult {
  readonly output: NodeOutput;
  /**
   * What this attempt spent. Reported here and on `TaskExecutionFailure`, so
   * an executor accounts for its own spend whichever way the attempt ended.
   * Executors that do not account for usage report nothing.
   */
  readonly usage?: TaskUsage;
  /**
   * Long-form text retained beside the report, under the run, for later
   * review. It is never parsed and never reaches a dependent task.
   */
  readonly artifact?: string;
  readonly diagnostics?: string;
}

export interface TaskExecutorTask {
  readonly id: string;
  readonly payload: unknown;
}

/**
 * Executors must stop all underlying work promptly when `input.signal` aborts.
 * Ignoring the signal violates the adapter contract and may allow work to outlive
 * the graph run. Adapter-specific task validation must be exposed through
 * `validateTasks` so the complete graph is rejected before any worker starts.
 *
 * `validateTasks` reports a rejected graph by throwing. `runGraph` converts that
 * into a `RunGraphValidationError` carrying an `adapter_validation` issue, so
 * callers handle every pre-run rejection through one error type.
 */
export interface TaskExecutor {
  (input: TaskExecutionInput): Promise<TaskExecutionResult>;
  readonly validateTasks?: (tasks: readonly TaskExecutorTask[]) => void;
}

export interface RunGraphOptions<TPayload = unknown> {
  readonly stateRoot: string;
  readonly graph: GraphRequest<TPayload>;
  readonly workingDirectory: string;
  readonly executor: TaskExecutor;
  readonly signal?: AbortSignal;
  readonly taskTimeoutMs?: number;
  readonly maxRetainedRuns?: number;
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
      readonly usage?: TaskUsage;
      readonly diagnostics?: string;
    };

function validateRun<TPayload>(
  graph: GraphRequest<TPayload>,
  workingDirectory: string,
  taskTimeoutMs: number,
  maxRetainedRuns: number,
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
  if (
    !Number.isInteger(maxRetainedRuns) ||
    maxRetainedRuns <= 0 ||
    maxRetainedRuns > RUN_GRAPH_LIMITS.maxRetainedRuns
  ) {
    issues.push({
      code: "invalid_retention_limit",
      message: `Retained run count must be a positive integer no greater than ${RUN_GRAPH_LIMITS.maxRetainedRuns}`,
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

/**
 * Runs the executor's own whole-graph validation and normalizes its rejection
 * into the same structured error the runtime bounds use. Only allowlisted
 * adapter diagnostics are surfaced, so a rejected graph cannot leak adapter
 * internals into the caller's error path.
 */
function validateAdapterTasks(
  executor: TaskExecutor,
  tasks: readonly TaskExecutorTask[],
): void {
  if (!executor.validateTasks) return;
  try {
    executor.validateTasks(tasks);
  } catch (error) {
    const diagnostics = taskExecutionDiagnostics(error);
    if (diagnostics === undefined) throw error;
    const taskId = taskExecutionFailureTaskId(error);
    throw new RunGraphValidationError([
      {
        code: "adapter_validation",
        message:
          taskId === undefined
            ? diagnostics
            : `Task ${JSON.stringify(taskId)} rejected by the executor: ${diagnostics}`,
        ...(taskId === undefined ? {} : { taskId }),
      },
    ]);
  }
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
      keys.length > 4 ||
      !keys.includes("output") ||
      !keys.every(
        (key) =>
          typeof key === "string" &&
          (key === "output" ||
            key === "artifact" ||
            key === "usage" ||
            key === "diagnostics"),
      )
    ) {
      return invalidExecutorResult(taskId);
    }
    const outputDescriptor = Object.getOwnPropertyDescriptor(value, "output");
    const artifactDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "artifact",
    );
    const usageDescriptor = Object.getOwnPropertyDescriptor(value, "usage");
    const diagnosticsDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "diagnostics",
    );
    if (
      outputDescriptor === undefined ||
      !outputDescriptor.enumerable ||
      !("value" in outputDescriptor) ||
      (artifactDescriptor !== undefined &&
        (!artifactDescriptor.enumerable || !("value" in artifactDescriptor))) ||
      (usageDescriptor !== undefined &&
        (!usageDescriptor.enumerable || !("value" in usageDescriptor))) ||
      (diagnosticsDescriptor !== undefined &&
        (!diagnosticsDescriptor.enumerable ||
          !("value" in diagnosticsDescriptor)))
    ) {
      return invalidExecutorResult(taskId);
    }

    const output = parseNodeOutput(outputDescriptor.value);
    const artifact = parseNodeArtifact(artifactDescriptor?.value);
    const usage = parseTaskUsage(usageDescriptor?.value);
    const diagnostics = parseNodeDiagnostics(diagnosticsDescriptor?.value);
    // Only what a dependent task and the parent are handed is weighed against
    // this limit. `parseNodeArtifact` bounds the artifact separately, because
    // it reaches neither.
    const reported = {
      output,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
    if (
      jsonByteLength(reported as unknown as JsonValue) >
      RUN_GRAPH_LIMITS.maxOutputBytes
    ) {
      return invalidExecutorResult(taskId);
    }
    const boundedValue = {
      ...reported,
      ...(artifact === undefined ? {} : { artifact }),
      ...(usage === undefined ? {} : { usage }),
    };
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

/**
 * A timeout and an abort are decided by the runner, which discards whatever
 * the executor eventually settles with. The spend is still real, so usage the
 * executor did report is carried onto the runner's own outcome.
 */
function withUsage(
  result: SettledTask,
  usage: TaskUsage | undefined,
): SettledTask {
  return usage === undefined ? result : { ...result, usage };
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
    let abortResult: SettledTask | undefined;
    let cleanupTimeout: NodeJS.Timeout | undefined;
    const parentAbort = () => controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const settle = (result: SettledTask) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cleanupTimeout) clearTimeout(cleanupTimeout);
      parentSignal.removeEventListener("abort", parentAbort);
      controller.signal.removeEventListener("abort", abort);
      resolveTask(result);
    };
    const abort = () => {
      const result: SettledTask = timedOut
        ? {
            taskId: input.taskId,
            status: "failed",
            diagnostics: "Task executor timed out",
          }
        : {
            taskId: input.taskId,
            status: "aborted",
            diagnostics: "Graph run was aborted",
          };
      abortResult = result;
      cleanupTimeout = setTimeout(
        () => settle(result),
        RUN_GRAPH_LIMITS.maxExecutorCleanupMs,
      );
    };

    controller.signal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) {
      parentAbort();
      if (abortResult) settle(abortResult);
      return;
    }
    parentSignal.addEventListener("abort", parentAbort, { once: true });
    Promise.resolve()
      .then(() => executor(executionInput))
      .then(
        (result) => {
          const completed = validateExecutorResult(input.taskId, result);
          settle(
            abortResult === undefined
              ? completed
              : withUsage(abortResult, completed.usage),
          );
        },
        (error: unknown) => {
          settle(
            withUsage(
              abortResult ?? {
                taskId: input.taskId,
                status: "failed",
                diagnostics:
                  taskExecutionDiagnostics(error) ?? "Task executor failed",
              },
              taskExecutionUsage(error),
            ),
          );
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

/**
 * Runs one parent-owned store mutation against a lock that workers also take
 * to publish coordination records.
 *
 * A worker can be killed between acquiring the run mutation lock and releasing
 * it, and to the parent that lock is indistinguishable from one a live sibling
 * holds for an ordinary publication. The lock names its holder, so a lock left
 * by a task whose promise has already settled is recovered and the mutation
 * retried, while contention with a running sibling is waited out instead of
 * failing the graph. Each mutation is guarded on its own: an immutable record
 * that was already published must never be republished by a retry.
 */
type MutationGuard = <T>(mutate: () => Promise<T>) => Promise<T>;

function createMutationGuard(
  stateRoot: string,
  ownership: RunOwnership,
  isHolderFinished: (taskId: string) => boolean,
): MutationGuard {
  return async (mutate) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await mutate();
      } catch (error) {
        if (
          !(error instanceof RunStoreError) ||
          error.code !== "locked" ||
          attempt >= MUTATION_LOCK_ATTEMPTS
        ) {
          throw error;
        }
        await recoverRunMutationLock(stateRoot, ownership, isHolderFinished);
      }
    }
  };
}

async function settlePersistedBlocked(
  stateRoot: string,
  runId: string,
  graph: NormalizedGraph<JsonValue>,
  state: GraphState,
  ownership: RunOwnership,
  guard: MutationGuard,
): Promise<GraphState> {
  const settled = settleBlocked(graph, state);
  for (const task of graph.tasks) {
    if (
      state.get(task.id) === "pending" &&
      settled.get(task.id) === "blocked"
    ) {
      await guard(() =>
        writeNodeState(stateRoot, runId, task.id, "blocked", ownership),
      );
    }
  }
  return settled;
}

async function persistCompletion(
  stateRoot: string,
  runId: string,
  completion: SettledTask,
  ownership: RunOwnership,
  guard: MutationGuard,
): Promise<void> {
  const output =
    completion.status === "succeeded"
      ? {
          taskId: completion.taskId,
          status: completion.status,
          output: completion.output,
          ...(completion.artifact === undefined
            ? {}
            : { artifact: completion.artifact }),
          ...(completion.usage === undefined
            ? {}
            : { usage: completion.usage }),
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
            ...(completion.artifact === undefined
              ? {}
              : { artifact: completion.artifact }),
            ...(completion.usage === undefined
              ? {}
              : { usage: completion.usage }),
            ...(completion.diagnostics === undefined
              ? {}
              : { diagnostics: completion.diagnostics }),
          }
        : {
            taskId: completion.taskId,
            status: completion.status,
            ...(completion.usage === undefined
              ? {}
              : { usage: completion.usage }),
            ...(completion.diagnostics === undefined
              ? {}
              : { diagnostics: completion.diagnostics }),
          };
  // Contention is detected before either record is written, so a guarded
  // retry never republishes an immutable output it already stored.
  await guard(() => publishNodeOutput(stateRoot, runId, output, ownership));
  await guard(() =>
    writeNodeState(
      stateRoot,
      runId,
      completion.taskId,
      completion.status,
      ownership,
    ),
  );
}

async function abortPending(
  stateRoot: string,
  runId: string,
  graph: NormalizedGraph<JsonValue>,
  initialState: GraphState,
  ownership: RunOwnership,
  guard: MutationGuard,
): Promise<GraphState> {
  let state = await settlePersistedBlocked(
    stateRoot,
    runId,
    graph,
    initialState,
    ownership,
    guard,
  );
  while (!isGraphComplete(graph, state)) {
    const ready = readyFrontier(graph, state);
    if (ready.length === 0) {
      throw new Error("Graph has pending tasks but no abortable frontier");
    }
    for (const taskId of ready) {
      await persistCompletion(
        stateRoot,
        runId,
        {
          taskId,
          status: "aborted",
          diagnostics: "Graph run was aborted before task execution",
        },
        ownership,
        guard,
      );
      state = setNodeStatus(graph, state, taskId, "aborted");
    }
    state = await settlePersistedBlocked(
      stateRoot,
      runId,
      graph,
      state,
      ownership,
      guard,
    );
  }
  return state;
}

/**
 * Ends the parent's hold on a run once every task has settled, and reports the
 * first failure rather than throwing.
 *
 * Ownership is released even when the mutation lock could not be recovered
 * first: a run left owned admits no further work at all. In practice both
 * steps fail together, because each reads the same owner record and the
 * release takes the lock the recovery was meant to clear — so this orders the
 * attempts and picks the more informative failure rather than rescuing a run
 * whose state has already diverged.
 */
async function releaseRunHold(
  stateRoot: string,
  ownership: RunOwnership,
): Promise<unknown> {
  let failure: unknown;
  try {
    await recoverRunMutationLock(stateRoot, ownership);
  } catch (error) {
    failure = error;
  }
  try {
    await releaseRunOwnership(stateRoot, ownership);
  } catch (error) {
    failure ??= error;
  }
  return failure;
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
  const maxRetainedRuns = options.maxRetainedRuns ?? RUN_STORE_DEFAULT_MAX_RUNS;
  const issues = validateRun(
    options.graph,
    options.workingDirectory,
    taskTimeoutMs,
    maxRetainedRuns,
  );
  if (issues.length > 0) throw new RunGraphValidationError(issues);
  const graph = normalizeGraph(options.graph);
  validateAdapterTasks(options.executor, graph.tasks);

  const workingDirectory = resolve(options.workingDirectory);
  const created = await createRun(options.stateRoot, graph, maxRetainedRuns);
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
  const ownership = await acquireRunOwnership(options.stateRoot, created.runId);
  const concurrency = persistedGraph.concurrency ?? 1;
  const runController = new AbortController();
  const abortRun = () => runController.abort();
  if (options.signal?.aborted) abortRun();
  else options.signal?.addEventListener("abort", abortRun, { once: true });
  const signal = runController.signal;
  const running = new Map<string, Promise<SettledTask>>();
  let state = createInitialState(persistedGraph);
  let result: GraphRunResult;
  let cleanupFailure: unknown;
  const underMutationLock = createMutationGuard(
    options.stateRoot,
    ownership,
    // Answered only for a task of this graph that is no longer running, so a
    // lock a live worker still holds is waited out rather than taken away.
    (taskId) =>
      !running.has(taskId) &&
      persistedGraph.tasks.some((task) => task.id === taskId),
  );

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
          let prerequisiteContext: string | undefined;
          let contextTooLarge = false;
          try {
            prerequisiteContext = serializePrerequisiteReports(
              prerequisites,
              RUN_GRAPH_LIMITS.maxPrerequisiteBytes,
            ).text;
          } catch (error) {
            if (!(error instanceof PrerequisiteContextOverflowError)) {
              throw error;
            }
            contextTooLarge = true;
          }

          await underMutationLock(() =>
            writeNodeState(
              options.stateRoot,
              manifest.runId,
              taskId,
              "running",
              ownership,
            ),
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
                      "Serialized direct-prerequisite context exceeds limit",
                  })
                : executeTask(
                    options.executor,
                    {
                      runId: manifest.runId,
                      taskId,
                      payload: task.payload,
                      workingDirectory,
                      prerequisites,
                      prerequisiteContext: prerequisiteContext ?? "",
                      runStateRoot: options.stateRoot,
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
            ownership,
            underMutationLock,
          );
          break;
        }
        state = await settlePersistedBlocked(
          options.stateRoot,
          manifest.runId,
          persistedGraph,
          state,
          ownership,
          underMutationLock,
        );
        if (!isGraphComplete(persistedGraph, state)) {
          throw new Error("Graph made no scheduling progress");
        }
        break;
      }

      const completion = await Promise.race(running.values());
      running.delete(completion.taskId);
      await persistCompletion(
        options.stateRoot,
        manifest.runId,
        completion,
        ownership,
        underMutationLock,
      );
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
        ownership,
        underMutationLock,
      );
    }
    const nodes = await Promise.all(
      persistedGraph.tasks.map((task) =>
        readNodeState(options.stateRoot, manifest.runId, task.id),
      ),
    );
    result = {
      runId: manifest.runId,
      status: aggregateStatus(nodes),
      nodes,
    };
  } catch (error) {
    abortRun();
    await Promise.allSettled(running.values());
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortRun);
    cleanupFailure = await releaseRunHold(options.stateRoot, ownership);
  }
  // Reached only when the run itself succeeded, because the catch above always
  // rethrows. Cleanup therefore never replaces the error that ended a run,
  // which says far more than a failure to tidy up after it.
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}
