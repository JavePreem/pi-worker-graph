export interface GraphTask<TPayload = unknown> {
  readonly id: string;
  readonly needs?: readonly string[];
  readonly payload?: TPayload;
}

export interface GraphRequest<TPayload = unknown> {
  readonly tasks: readonly GraphTask<TPayload>[];
  readonly concurrency?: number;
}

export interface NormalizedGraphTask<TPayload = unknown> {
  readonly id: string;
  readonly needs: readonly string[];
  readonly payload: TPayload | undefined;
}

export interface NormalizedGraph<TPayload = unknown> {
  readonly tasks: readonly NormalizedGraphTask<TPayload>[];
  readonly concurrency: number | undefined;
}

export type GraphIssueCode =
  | "empty_id"
  | "duplicate_id"
  | "empty_dependency"
  | "unknown_dependency"
  | "self_dependency"
  | "cycle"
  | "invalid_concurrency";

export interface GraphIssue {
  readonly code: GraphIssueCode;
  readonly message: string;
  readonly taskId?: string;
  readonly dependencyId?: string;
  readonly cycle?: readonly string[];
}

export class GraphValidationError extends Error {
  readonly issues: readonly GraphIssue[];

  constructor(issues: readonly GraphIssue[]) {
    super(`Invalid graph: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "GraphValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export type NodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "blocked";

export type GraphState = ReadonlyMap<string, NodeStatus>;

const TERMINAL_STATUSES = new Set<NodeStatus>([
  "succeeded",
  "failed",
  "aborted",
  "blocked",
]);

const BLOCKING_STATUSES = new Set<NodeStatus>(["failed", "aborted", "blocked"]);

const VALID_STATUSES = new Set<NodeStatus>([
  "pending",
  "running",
  ...TERMINAL_STATUSES,
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<NodeStatus, ReadonlySet<NodeStatus>>
> = {
  pending: new Set(["running", "failed", "aborted"]),
  running: new Set(["succeeded", "failed", "aborted"]),
  succeeded: new Set(),
  failed: new Set(),
  aborted: new Set(),
  blocked: new Set(),
};

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedTasks<TPayload>(
  request: GraphRequest<TPayload>,
): NormalizedGraphTask<TPayload>[] {
  return request.tasks.map((task) => ({
    id: task.id.trim(),
    needs: [
      ...new Set((task.needs ?? []).map((dependency) => dependency.trim())),
    ].sort(compareIds),
    payload: task.payload,
  }));
}

function findCycle<TPayload>(
  tasks: readonly NormalizedGraphTask<TPayload>[],
): readonly string[] | undefined {
  const taskIds = new Set(tasks.map((task) => task.id));
  const dependencies = new Map(
    tasks.map((task) => [
      task.id,
      task.needs.filter(
        (dependency) =>
          dependency !== task.id &&
          taskIds.has(dependency) &&
          dependency.length > 0,
      ),
    ]),
  );
  const marks = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const pathIndexes = new Map<string, number>();

  for (const rootId of [...taskIds].sort(compareIds)) {
    if (marks.has(rootId)) continue;

    const frames: Array<{ taskId: string; nextDependency: number }> = [
      { taskId: rootId, nextDependency: 0 },
    ];
    marks.set(rootId, "visiting");
    pathIndexes.set(rootId, path.length);
    path.push(rootId);

    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (!frame) break;
      const taskDependencies = dependencies.get(frame.taskId) ?? [];

      if (frame.nextDependency >= taskDependencies.length) {
        frames.pop();
        path.pop();
        pathIndexes.delete(frame.taskId);
        marks.set(frame.taskId, "visited");
        continue;
      }

      const dependency = taskDependencies[frame.nextDependency];
      frame.nextDependency += 1;
      if (dependency === undefined) continue;

      const mark = marks.get(dependency);
      if (mark === "visiting") {
        const start = pathIndexes.get(dependency);
        if (start !== undefined) return [...path.slice(start), dependency];
      } else if (mark === undefined) {
        marks.set(dependency, "visiting");
        pathIndexes.set(dependency, path.length);
        path.push(dependency);
        frames.push({ taskId: dependency, nextDependency: 0 });
      }
    }
  }

  return undefined;
}

export function validateGraph<TPayload>(
  request: GraphRequest<TPayload>,
): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];
  const tasks = normalizedTasks(request);
  const taskIds = new Set<string>();

  for (const task of tasks) {
    if (task.id.length === 0) {
      issues.push({
        code: "empty_id",
        message: "Task IDs must not be empty",
      });
      continue;
    }
    if (taskIds.has(task.id)) {
      issues.push({
        code: "duplicate_id",
        taskId: task.id,
        message: `Task ID ${JSON.stringify(task.id)} is duplicated`,
      });
      continue;
    }
    taskIds.add(task.id);
  }

  for (const [index, task] of tasks.entries()) {
    const originalNeeds = request.tasks[index]?.needs ?? [];
    for (const originalDependency of originalNeeds) {
      const dependency = originalDependency.trim();
      if (dependency.length === 0) {
        issues.push({
          code: "empty_dependency",
          ...(task.id.length > 0 ? { taskId: task.id } : {}),
          message: `Task ${JSON.stringify(task.id)} has an empty dependency`,
        });
      }
    }

    for (const dependency of task.needs) {
      if (dependency.length === 0) continue;
      if (dependency === task.id) {
        issues.push({
          code: "self_dependency",
          taskId: task.id,
          dependencyId: dependency,
          message: `Task ${JSON.stringify(task.id)} depends on itself`,
        });
      } else if (!taskIds.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          taskId: task.id,
          dependencyId: dependency,
          message: `Task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        });
      }
    }
  }

  if (
    request.concurrency !== undefined &&
    (!Number.isInteger(request.concurrency) || request.concurrency <= 0)
  ) {
    issues.push({
      code: "invalid_concurrency",
      message: "Concurrency must be a positive integer",
    });
  }

  if (!issues.some((issue) => issue.code === "duplicate_id")) {
    const cycle = findCycle(tasks);
    if (cycle) {
      issues.push({
        code: "cycle",
        cycle,
        message: `Graph contains a cycle: ${cycle.join(" -> ")}`,
      });
    }
  }

  return Object.freeze(issues);
}

export function normalizeGraph<TPayload>(
  request: GraphRequest<TPayload>,
): NormalizedGraph<TPayload> {
  const issues = validateGraph(request);
  if (issues.length > 0) throw new GraphValidationError(issues);

  const tasks = normalizedTasks(request).map((task) =>
    Object.freeze({
      ...task,
      needs: Object.freeze(task.needs),
    }),
  );

  return Object.freeze({
    tasks: Object.freeze(tasks),
    concurrency: request.concurrency,
  });
}

function assertGraphState<TPayload>(
  graph: NormalizedGraph<TPayload>,
  state: GraphState,
): void {
  const taskIds = new Set(graph.tasks.map((task) => task.id));
  if (state.size !== taskIds.size) {
    throw new Error("Graph state does not contain exactly one entry per task");
  }

  for (const taskId of taskIds) {
    const status = state.get(taskId);
    if (status === undefined || !VALID_STATUSES.has(status)) {
      throw new Error(
        `Graph state is missing a valid status for ${JSON.stringify(taskId)}`,
      );
    }
  }

  for (const taskId of state.keys()) {
    if (!taskIds.has(taskId)) {
      throw new Error(
        `Graph state contains unknown task ${JSON.stringify(taskId)}`,
      );
    }
  }
}

function readonlyState(
  entries: Iterable<readonly [string, NodeStatus]>,
): GraphState {
  const values = new Map(entries);
  let state: GraphState;

  state = Object.freeze({
    get size() {
      return values.size;
    },
    get(key: string) {
      return values.get(key);
    },
    has(key: string) {
      return values.has(key);
    },
    entries() {
      return values.entries();
    },
    keys() {
      return values.keys();
    },
    values() {
      return values.values();
    },
    forEach(
      callback: (value: NodeStatus, key: string, map: GraphState) => void,
      thisArg?: unknown,
    ) {
      values.forEach((value, key) => {
        callback.call(thisArg, value, key, state);
      });
    },
    [Symbol.iterator]() {
      return values[Symbol.iterator]();
    },
    [Symbol.toStringTag]: "GraphState",
  });

  return state;
}

export function createInitialState<TPayload>(
  graph: NormalizedGraph<TPayload>,
): GraphState {
  return readonlyState(
    graph.tasks.map((task) => [task.id, "pending"] as const),
  );
}

export function setNodeStatus<TPayload>(
  graph: NormalizedGraph<TPayload>,
  state: GraphState,
  taskId: string,
  status: NodeStatus,
): GraphState {
  assertGraphState(graph, state);
  const current = state.get(taskId);
  if (current === undefined) {
    throw new Error(`Unknown task ${JSON.stringify(taskId)}`);
  }
  if (current === status) return state;
  if (!ALLOWED_TRANSITIONS[current].has(status)) {
    throw new Error(
      `Invalid task transition for ${JSON.stringify(taskId)}: ${current} -> ${status}`,
    );
  }
  if (current === "pending" && status === "running") {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    if (
      !task?.needs.every((dependency) => state.get(dependency) === "succeeded")
    ) {
      throw new Error(
        `Task ${JSON.stringify(taskId)} cannot start before all prerequisites succeed`,
      );
    }
  }

  const next = new Map(state);
  next.set(taskId, status);
  return readonlyState(next);
}

/**
 * Returns every currently eligible task in deterministic order.
 * Executors apply `graph.concurrency` when selecting tasks from this frontier.
 */
export function readyFrontier<TPayload>(
  graph: NormalizedGraph<TPayload>,
  state: GraphState,
): readonly string[] {
  assertGraphState(graph, state);

  return graph.tasks
    .filter(
      (task) =>
        state.get(task.id) === "pending" &&
        task.needs.every((dependency) => state.get(dependency) === "succeeded"),
    )
    .map((task) => task.id)
    .sort(compareIds);
}

export function settleBlocked<TPayload>(
  graph: NormalizedGraph<TPayload>,
  state: GraphState,
): GraphState {
  assertGraphState(graph, state);
  const next = new Map(state);
  let changed = true;

  while (changed) {
    changed = false;
    for (const task of graph.tasks) {
      if (next.get(task.id) !== "pending") continue;
      if (
        task.needs.some((dependency) =>
          BLOCKING_STATUSES.has(next.get(dependency) as NodeStatus),
        )
      ) {
        next.set(task.id, "blocked");
        changed = true;
      }
    }
  }

  return readonlyState(next);
}

export function isGraphComplete<TPayload>(
  graph: NormalizedGraph<TPayload>,
  state: GraphState,
): boolean {
  assertGraphState(graph, state);
  return graph.tasks.every((task) =>
    TERMINAL_STATUSES.has(state.get(task.id) as NodeStatus),
  );
}
