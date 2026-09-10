import type { TaskUsage } from "./usage.js";
import { parseTaskUsage } from "./usage.js";

export type TaskExecutionFailureCode =
  | "invalid_assignment"
  | "invalid_profile"
  | "startup"
  | "protocol"
  | "output_limit"
  | "provider"
  | "report_tool"
  | "missing_report"
  | "report_not_final"
  | "unresolved_command"
  | "process";

const FAILURE_DIAGNOSTICS: Readonly<Record<TaskExecutionFailureCode, string>> =
  Object.freeze({
    invalid_assignment: "Worker assignment is invalid",
    invalid_profile: "Worker profile is invalid",
    startup: "Pi worker process failed to start",
    protocol: "Pi worker emitted an invalid event stream",
    output_limit: "Pi worker event stream exceeded its output limit",
    provider: "Pi worker provider request failed",
    report_tool: "Pi worker final-report tool failed",
    missing_report: "Pi worker did not submit a final report",
    report_not_final: "Pi worker kept working after its final report",
    unresolved_command: "Pi worker command could not be resolved",
    process: "Pi worker process failed",
  });

/**
 * Allowlisted executor failure. Diagnostics come from the fixed table above, so
 * an executor can describe why a task failed without any provider text, tool
 * output, or repository content reaching persisted run state.
 *
 * `taskId` is only set by whole-graph validation, where the failing task is
 * known before any worker starts.
 *
 * `usage` is what the attempt had already spent when it failed. A failed
 * worker is still a worker that consumed tokens, so an executor that accounts
 * for its own spend reports it here rather than losing it with the failure.
 */
export class TaskExecutionFailure extends Error {
  readonly code: TaskExecutionFailureCode;
  readonly diagnostics: string;
  readonly taskId: string | undefined;
  readonly usage: TaskUsage | undefined;

  constructor(
    code: TaskExecutionFailureCode,
    taskId?: string,
    usage?: TaskUsage,
  ) {
    const diagnostics = FAILURE_DIAGNOSTICS[code];
    super(diagnostics);
    this.name = "TaskExecutionFailure";
    this.code = code;
    this.diagnostics = diagnostics;
    this.taskId = taskId;
    this.usage = usage;
  }
}

/**
 * Resolves the allowlisted diagnostics for an executor rejection, or
 * `undefined` when the rejection is not a recognized failure.
 *
 * Third-party executors may be bundled against a separate copy of this module,
 * which defeats `instanceof`. The fallback matches the reported code against
 * the allowlist rather than trusting any caller-supplied text, so a duplicated
 * module cannot widen what reaches run state.
 */
export function taskExecutionDiagnostics(error: unknown): string | undefined {
  if (error instanceof TaskExecutionFailure) return error.diagnostics;
  if (!(error instanceof Error) || error.name !== "TaskExecutionFailure") {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(FAILURE_DIAGNOSTICS, code)
    ? FAILURE_DIAGNOSTICS[code as TaskExecutionFailureCode]
    : undefined;
}

/**
 * Reads the usage an executor attributed to a failed attempt, if any.
 *
 * Validated rather than trusted, and read defensively for the same reason
 * `taskExecutionDiagnostics` is: the rejection may come from a separate copy
 * of this module. Unusable numbers are dropped rather than persisted.
 */
export function taskExecutionUsage(error: unknown): TaskUsage | undefined {
  if (!(error instanceof Error) || error.name !== "TaskExecutionFailure") {
    return undefined;
  }
  try {
    return parseTaskUsage((error as { readonly usage?: unknown }).usage);
  } catch {
    return undefined;
  }
}

/** Reads the task attributed to a whole-graph validation failure, if any. */
export function taskExecutionFailureTaskId(error: unknown): string | undefined {
  if (error instanceof TaskExecutionFailure) return error.taskId;
  if (!(error instanceof Error) || error.name !== "TaskExecutionFailure") {
    return undefined;
  }
  const taskId = (error as { readonly taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}
