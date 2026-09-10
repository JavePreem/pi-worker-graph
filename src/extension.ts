import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadWorkerGraphConfiguration } from "./config.js";
import {
  registerWorkerCoordinationTools,
  workerCoordinationContext,
} from "./coordination.js";
import { isRecord } from "./json.js";
import {
  registerWorkerGraphOrchestratorTool,
  WORKER_GRAPH_TOOL_NAME,
  type WorkerGraphOrchestratorDependencies,
} from "./orchestrator.js";
import {
  NODE_OUTPUT_LIMITS,
  NODE_OUTPUT_SCHEMA_VERSION,
  parseNodeArtifact,
  parseNodeOutput,
  splitReportArtifact,
} from "./output.js";
import type {
  PiOrchestratorProfile,
  PiSessionThinkingLevel,
} from "./pi-subprocess.js";
import type { RetainedRun } from "./store.js";
import { deleteRun, listRetainedRuns } from "./store.js";

const WORKER_ROLE_VARIABLE = "PI_WORKER_GRAPH_ROLE";
const WORKER_ROLE = "worker";
const MODE_ENTRY_TYPE = "worker-graph-mode";
const MODE_STATE_SCHEMA_VERSION = 1;
const MAX_MODE_TOOL_COUNT = 256;
const MAX_MODE_NAME_BYTES = 256;
const DISABLED_PARENT_TOOLS = new Set(["bash", "edit", "write"]);
const MODE_STATE_FIELDS = new Set([
  "schemaVersion",
  "enabled",
  "toolsBeforeMode",
  "modelBeforeMode",
  "thinkingLevelBeforeMode",
]);
const MODE_MODEL_FIELDS = new Set(["provider", "modelId"]);
const SESSION_THINKING_LEVELS = new Set<PiSessionThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SWARM_USAGE = "Usage: /swarm on|status|off|runs|delete <run-id>";
const SWARM_DELETE_USAGE = "Usage: /swarm delete <run-id>";
const UNRESTORABLE_TOOLS_MESSAGE =
  "Worker-graph mode not enabled: the active tool set cannot be restored later";
const UNRESTORABLE_MODEL_MESSAGE =
  "Worker-graph mode not enabled: the session's current model cannot be restored later";
const UNKNOWN_MODEL_MESSAGE =
  "Worker-graph mode not enabled: the configured orchestrator model is not available";
const UNAUTHENTICATED_MODEL_MESSAGE =
  "Worker-graph mode not enabled: the configured orchestrator model has no configured authentication";
const UNREADABLE_CONFIGURATION_MESSAGE =
  "Worker-graph mode not enabled: the worker-graph configuration could not be read";
const MODEL_NOT_RESTORED_MESSAGE =
  "Worker-graph mode left the session on the orchestrator model: the model it started from is no longer available";
export const WORKER_REPORT_TOOL_NAME = "worker_graph_report";
export const SWARM_COMMAND_NAME = "swarm";
export const SWARM_FLAG_NAME = "swarm";

interface ModeModelSnapshot {
  readonly provider: string;
  readonly modelId: string;
}

interface WorkerGraphModeState {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly toolsBeforeMode?: readonly string[];
  /**
   * Absent whenever the mode changed no model: either the configuration names
   * no orchestrator profile, or the record predates that field.
   */
  readonly modelBeforeMode?: ModeModelSnapshot;
  readonly thinkingLevelBeforeMode?: PiSessionThinkingLevel;
}

function modeToolSnapshot(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_MODE_TOOL_COUNT
  ) {
    return undefined;
  }
  const tools: string[] = [];
  for (const tool of value) {
    if (
      typeof tool !== "string" ||
      tool.trim().length === 0 ||
      tool !== tool.trim() ||
      Buffer.byteLength(tool) > MAX_MODE_NAME_BYTES ||
      tool === WORKER_GRAPH_TOOL_NAME ||
      tools.includes(tool)
    ) {
      return undefined;
    }
    tools.push(tool);
  }
  return Object.freeze(tools);
}

function boundedName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value) <= MAX_MODE_NAME_BYTES
  );
}

/**
 * The parent's model is recorded as the two identifiers that find it again,
 * not as Pi's model object: only a provider and an id can be read back through
 * the same bounds after a reload.
 */
function modeModelSnapshot(value: unknown): ModeModelSnapshot | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => !MODE_MODEL_FIELDS.has(field)) ||
    !boundedName(value.provider) ||
    !boundedName(value.modelId)
  ) {
    return undefined;
  }
  return Object.freeze({ provider: value.provider, modelId: value.modelId });
}

function parseModeState(value: unknown): WorkerGraphModeState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).some((field) => !MODE_STATE_FIELDS.has(field)) ||
    value.schemaVersion !== MODE_STATE_SCHEMA_VERSION ||
    typeof value.enabled !== "boolean"
  ) {
    return undefined;
  }
  if (!value.enabled) {
    return value.toolsBeforeMode === undefined
      ? { schemaVersion: MODE_STATE_SCHEMA_VERSION, enabled: false }
      : undefined;
  }
  const toolsBeforeMode = modeToolSnapshot(value.toolsBeforeMode);
  if (toolsBeforeMode === undefined) return undefined;
  // The model and its thinking level were captured together and are restored
  // together, so a record carrying one without the other is not restorable.
  const hasModel = value.modelBeforeMode !== undefined;
  const hasLevel = value.thinkingLevelBeforeMode !== undefined;
  if (hasModel !== hasLevel) return undefined;
  if (!hasModel) {
    return Object.freeze({
      schemaVersion: MODE_STATE_SCHEMA_VERSION,
      enabled: true,
      toolsBeforeMode,
    });
  }
  const modelBeforeMode = modeModelSnapshot(value.modelBeforeMode);
  if (
    modelBeforeMode === undefined ||
    typeof value.thinkingLevelBeforeMode !== "string" ||
    !SESSION_THINKING_LEVELS.has(
      value.thinkingLevelBeforeMode as PiSessionThinkingLevel,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: MODE_STATE_SCHEMA_VERSION,
    enabled: true,
    toolsBeforeMode,
    modelBeforeMode,
    thinkingLevelBeforeMode:
      value.thinkingLevelBeforeMode as PiSessionThinkingLevel,
  });
}

function latestModeState(
  entries: readonly unknown[],
): WorkerGraphModeState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === MODE_ENTRY_TYPE
    ) {
      return parseModeState(entry.data);
    }
  }
  return undefined;
}

/**
 * `parseNodeOutput` measures every limit in UTF-8 bytes, but JSON Schema can
 * only express `maxLength` in characters. `maxLength` therefore stays a coarse
 * upper bound and the byte limit is stated in the field description, so the
 * caller sees the real contract instead of discovering it through a rejection.
 */
const boundedText = (purpose: string) =>
  Type.String({
    minLength: 1,
    maxLength: NODE_OUTPUT_LIMITS.maxTextBytes,
    description: `${purpose} At most ${NODE_OUTPUT_LIMITS.maxTextBytes} bytes of UTF-8.`,
  });

const nodeOutputProperties = {
  // Expressed as a bounded integer rather than a literal: a `const` keyword
  // is rejected by some providers' strict function-schema validation.
  schemaVersion: Type.Integer({
    minimum: NODE_OUTPUT_SCHEMA_VERSION,
    maximum: NODE_OUTPUT_SCHEMA_VERSION,
    description: `Report format version. Always ${NODE_OUTPUT_SCHEMA_VERSION}.`,
  }),
  summary: boundedText("What was done, and whether the assignment is met."),
  changedFiles: Type.Array(
    Type.Object(
      {
        path: Type.String({
          minLength: 1,
          maxLength: NODE_OUTPUT_LIMITS.maxPathBytes,
          description: `Repository-relative path. At most ${NODE_OUTPUT_LIMITS.maxPathBytes} bytes of UTF-8.`,
        }),
        description: boundedText("What changed in this file, and why."),
      },
      { additionalProperties: false },
    ),
    { maxItems: NODE_OUTPUT_LIMITS.maxItemsPerSection },
  ),
  interfaces: Type.Array(
    boundedText("One interface downstream tasks must build against."),
    { maxItems: NODE_OUTPUT_LIMITS.maxItemsPerSection },
  ),
  decisions: Type.Array(
    boundedText("One decision downstream tasks need to know about."),
    { maxItems: NODE_OUTPUT_LIMITS.maxItemsPerSection },
  ),
  validation: Type.Array(
    Type.Object(
      {
        command: boundedText("The command that was run."),
        result: boundedText("What the command reported."),
      },
      { additionalProperties: false },
    ),
    { maxItems: NODE_OUTPUT_LIMITS.maxItemsPerSection },
  ),
  blockers: Type.Array(
    boundedText("One reason the assignment could not be completed."),
    { maxItems: NODE_OUTPUT_LIMITS.maxItemsPerSection },
  ),
};

/**
 * The artifact is a sibling of the report, not a field of it: it is retained
 * under the run for later review and never reaches a dependent task, so it is
 * bounded on its own and leaves the report envelope at schema version 1.
 */
const workerReportSchema = Type.Object(
  {
    ...nodeOutputProperties,
    artifact: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: NODE_OUTPUT_LIMITS.maxArtifactBytes,
        description: [
          "Optional supplemental long-form text retained beside the report:",
          "logs, investigation notes, or detailed review findings.",
          "It is stored under the run for later review and is never given to",
          "dependent tasks, so the structured report above must still stand",
          "on its own.",
          `At most ${NODE_OUTPUT_LIMITS.maxArtifactBytes} bytes of UTF-8.`,
        ].join(" "),
      }),
    ),
  },
  { additionalProperties: false },
);

function registerWorkerReportTool(pi: ExtensionAPI): void {
  let submitted = false;
  pi.registerTool({
    name: WORKER_REPORT_TOOL_NAME,
    label: "Worker Graph Report",
    description: [
      "Submit the required final structured task report.",
      "Call this exactly once as your final action.",
      `The whole report must serialize to at most ${NODE_OUTPUT_LIMITS.maxBytes} bytes of UTF-8,`,
      "which is a smaller budget than the per-field limits allow together;",
      "a rejected report can be corrected and resubmitted.",
      "Supplemental long-form material belongs in the optional artifact field,",
      "which is retained separately and never shortens the report.",
    ].join(" "),
    promptSnippet: "Submit the final worker report and end the task",
    promptGuidelines: [
      "Use worker_graph_report exactly once as the final action after completing or blocking the assigned task.",
      "Report blockers honestly; do not claim success when required work or validation is incomplete.",
      `Keep the whole report within ${NODE_OUTPUT_LIMITS.maxBytes} bytes by summarizing rather than pasting file contents or command transcripts.`,
      "Put logs, investigation notes, and detailed findings in artifact rather than in the report, and never at the cost of a complete report: every blocker, interface, decision, changed file, and validation result belongs in the structured fields, because dependent tasks receive those and never the artifact.",
    ],
    parameters: workerReportSchema,
    async execute(_toolCallId, params) {
      if (submitted)
        throw new Error("A final worker report was already submitted");
      // Thrown validation errors reach the model as a tool error, so the
      // message must say what to change. The parent treats a rejected report
      // as recoverable and waits for a corrected resubmission. The artifact
      // is separated before validation, so it is never mistaken for an
      // undeclared report field, and the split is defensive rather than a
      // destructuring: the submitted value is never read through an accessor.
      const parts = splitReportArtifact(params);
      const output = parseNodeOutput(parts.report);
      const artifact = parseNodeArtifact(parts.artifact);
      submitted = true;
      return {
        content: [{ type: "text", text: "Final worker report submitted." }],
        details: {
          kind: "worker-graph-node-output",
          output,
          ...(artifact === undefined ? {} : { artifact }),
        },
        terminate: true,
      };
    },
  });
}

/**
 * One line per unit of retained capacity. A run with no slot, and a slot with
 * no readable run, are both shown rather than omitted: they are the states an
 * operator is reading this to find.
 */
function retainedRunsText(runs: readonly RetainedRun[]): string {
  if (runs.length === 0) return "The run store retains no runs";
  return [
    `The run store retains ${runs.length} run(s), oldest first:`,
    ...runs.map((run) =>
      [
        run.runId ?? "(slot names no run)",
        `slot ${run.slot ?? "none"}`,
        run.createdAt ?? "unreadable",
        run.owned ? "owned" : "free",
      ].join("  "),
    ),
  ].join("\n");
}

function orchestratorDependencies(
  dependencies: Partial<WorkerGraphOrchestratorDependencies>,
): WorkerGraphOrchestratorDependencies {
  return {
    getAgentDirectory: dependencies.getAgentDirectory ?? getAgentDir,
    ...(dependencies.loadConfiguration === undefined
      ? {}
      : { loadConfiguration: dependencies.loadConfiguration }),
    ...(dependencies.createExecutor === undefined
      ? {}
      : { createExecutor: dependencies.createExecutor }),
    ...(dependencies.executeGraph === undefined
      ? {}
      : { executeGraph: dependencies.executeGraph }),
    ...(dependencies.readOutput === undefined
      ? {}
      : { readOutput: dependencies.readOutput }),
  };
}

/** Pi package entry point with mutually exclusive worker and parent roles. */
export default function registerWorkerGraph(
  pi: ExtensionAPI,
  dependencies: Partial<WorkerGraphOrchestratorDependencies> = {},
): void {
  if (process.env[WORKER_ROLE_VARIABLE] === WORKER_ROLE) {
    registerWorkerReportTool(pi);
    const coordination = workerCoordinationContext();
    if (coordination !== undefined) {
      registerWorkerCoordinationTools(pi, coordination);
    }
    return;
  }

  pi.registerFlag(SWARM_FLAG_NAME, {
    description: "Start with worker-graph orchestration enabled",
    type: "boolean",
    default: false,
  });
  const resolved = orchestratorDependencies(dependencies);
  const loadConfiguration =
    resolved.loadConfiguration ?? loadWorkerGraphConfiguration;
  registerWorkerGraphOrchestratorTool(pi, resolved);

  let enabled = false;
  let toolsBeforeMode: readonly string[] | undefined;
  let modelBeforeMode: ModeModelSnapshot | undefined;
  let thinkingLevelBeforeMode: PiSessionThinkingLevel | undefined;
  /** The profile the mode applied, for `/swarm status`. */
  let appliedOrchestrator: PiOrchestratorProfile | undefined;

  const refuse = (message: string) => ({ ok: false as const, message });

  /**
   * Puts the session back on a recorded model. A model Pi can no longer find,
   * or one whose provider lost its authentication, leaves the session where it
   * is rather than throwing at whoever was leaving the mode.
   */
  const applyModel = async (
    ctx: ExtensionContext,
    snapshot: ModeModelSnapshot,
    level: PiSessionThinkingLevel,
  ): Promise<boolean> => {
    const model = ctx.modelRegistry.find(snapshot.provider, snapshot.modelId);
    if (model === undefined || !(await pi.setModel(model))) return false;
    pi.setThinkingLevel(level);
    return true;
  };

  /**
   * The snapshot is captured through the same bounds that restore it. A tool set
   * this extension could not read back must never enable the mode, because the
   * suppressed parent tools would then be unrecoverable after a reload. The
   * parent's model is held to the same rule: the mode only moves a session onto
   * a configured model once it knows the identifiers that move it back.
   */
  const activate = async (
    ctx: ExtensionContext,
    restored?: WorkerGraphModeState,
  ): Promise<
    | { readonly ok: true; readonly warning?: string }
    | { readonly ok: false; readonly message: string }
  > => {
    const snapshot =
      restored?.toolsBeforeMode ??
      toolsBeforeMode ??
      modeToolSnapshot(
        pi.getActiveTools().filter((name) => name !== WORKER_GRAPH_TOOL_NAME),
      );
    if (snapshot === undefined) return refuse(UNRESTORABLE_TOOLS_MESSAGE);

    let restoredModelFailed = false;
    let orchestrator: PiOrchestratorProfile | undefined;
    try {
      orchestrator = (
        await loadConfiguration({
          agentDirectory: resolved.getAgentDirectory(),
          workingDirectory: ctx.cwd,
        })
      ).orchestrator;
    } catch (error) {
      return refuse(
        error instanceof Error
          ? `Worker-graph mode not enabled: ${error.message}`
          : UNREADABLE_CONFIGURATION_MESSAGE,
      );
    }

    const applyTools = () => {
      pi.setActiveTools([
        ...snapshot.filter((name) => !DISABLED_PARENT_TOOLS.has(name)),
        WORKER_GRAPH_TOOL_NAME,
      ]);
    };

    if (orchestrator === undefined) {
      /**
       * The configuration named an orchestrator when this branch was recorded
       * and no longer does. The recorded model is the only way back, so it is
       * restored here rather than discarded: dropping it would strand the
       * session on a model the operator has since removed from the file.
       */
      const stranded = restored?.modelBeforeMode ?? modelBeforeMode;
      const strandedLevel =
        restored?.thinkingLevelBeforeMode ?? thinkingLevelBeforeMode;
      if (stranded !== undefined && strandedLevel !== undefined) {
        restoredModelFailed = !(await applyModel(ctx, stranded, strandedLevel));
      }
      toolsBeforeMode = snapshot;
      modelBeforeMode = undefined;
      thinkingLevelBeforeMode = undefined;
      appliedOrchestrator = undefined;
      applyTools();
      return {
        ok: true,
        ...(restoredModelFailed ? { warning: MODEL_NOT_RESTORED_MESSAGE } : {}),
      };
    }

    /**
     * A restored branch already recorded the model the operator started from.
     * The live session may by then be running the orchestrator model, so the
     * record is what gets carried forward rather than the current model.
     */
    let previousModel = restored?.modelBeforeMode ?? modelBeforeMode;
    let previousLevel =
      restored?.thinkingLevelBeforeMode ?? thinkingLevelBeforeMode;
    if (previousModel === undefined || previousLevel === undefined) {
      const current = ctx.model;
      const level = pi.getThinkingLevel();
      if (
        current === undefined ||
        !boundedName(current.provider) ||
        !boundedName(current.id) ||
        ctx.modelRegistry.find(current.provider, current.id) === undefined ||
        !SESSION_THINKING_LEVELS.has(level as PiSessionThinkingLevel)
      ) {
        return refuse(UNRESTORABLE_MODEL_MESSAGE);
      }
      previousModel = Object.freeze({
        provider: current.provider,
        modelId: current.id,
      });
      previousLevel = level as PiSessionThinkingLevel;
    }

    const target = ctx.modelRegistry.find(
      orchestrator.provider,
      orchestrator.model,
    );
    if (target === undefined) return refuse(UNKNOWN_MODEL_MESSAGE);

    applyTools();
    if (!(await pi.setModel(target))) {
      // Nothing is left half-applied: the tool set goes back before the
      // refusal, because the mode is not being entered.
      pi.setActiveTools([...snapshot]);
      return refuse(UNAUTHENTICATED_MODEL_MESSAGE);
    }
    pi.setThinkingLevel(orchestrator.thinkingLevel);
    toolsBeforeMode = snapshot;
    modelBeforeMode = previousModel;
    thinkingLevelBeforeMode = previousLevel;
    appliedOrchestrator = orchestrator;
    return { ok: true };
  };

  /** True when a recorded model could not be put back. */
  const deactivate = async (ctx: ExtensionContext): Promise<boolean> => {
    let failed = false;
    if (
      modelBeforeMode !== undefined &&
      thinkingLevelBeforeMode !== undefined
    ) {
      failed = !(await applyModel(
        ctx,
        modelBeforeMode,
        thinkingLevelBeforeMode,
      ));
      modelBeforeMode = undefined;
      thinkingLevelBeforeMode = undefined;
    }
    appliedOrchestrator = undefined;
    if (toolsBeforeMode !== undefined) {
      pi.setActiveTools([...toolsBeforeMode]);
      toolsBeforeMode = undefined;
      return failed;
    }
    const active = pi.getActiveTools();
    if (active.includes(WORKER_GRAPH_TOOL_NAME)) {
      pi.setActiveTools(
        active.filter((name) => name !== WORKER_GRAPH_TOOL_NAME),
      );
    }
    return failed;
  };

  const persistModeState = () => {
    pi.appendEntry(MODE_ENTRY_TYPE, {
      schemaVersion: MODE_STATE_SCHEMA_VERSION,
      enabled,
      ...(enabled && toolsBeforeMode !== undefined
        ? { toolsBeforeMode: [...toolsBeforeMode] }
        : {}),
      ...(enabled &&
      modelBeforeMode !== undefined &&
      thinkingLevelBeforeMode !== undefined
        ? {
            modelBeforeMode: { ...modelBeforeMode },
            thinkingLevelBeforeMode,
          }
        : {}),
    });
  };

  /**
   * The startup flag applies only to the launch that carried it. Navigating the
   * session tree restores what the branch recorded, so `/swarm off` is never
   * undone by the flag that started the session.
   */
  const restoreModeState = async (
    ctx: ExtensionContext,
    applyStartupFlag: boolean,
  ): Promise<{
    readonly persist: boolean;
    readonly refused?: string;
    readonly warning?: string;
  }> => {
    const restoreFailed = await deactivate(ctx);
    const state = latestModeState(ctx.sessionManager.getBranch());
    const enabledByFlag =
      applyStartupFlag && pi.getFlag(SWARM_FLAG_NAME) === true;
    const requested = enabledByFlag || state?.enabled === true;
    if (!requested) {
      enabled = false;
      return {
        persist: false,
        ...(restoreFailed ? { warning: MODEL_NOT_RESTORED_MESSAGE } : {}),
      };
    }
    const result = await activate(
      ctx,
      state?.enabled === true ? state : undefined,
    );
    enabled = result.ok;
    const warning = restoreFailed
      ? MODEL_NOT_RESTORED_MESSAGE
      : result.ok
        ? result.warning
        : undefined;
    return {
      persist: enabled && enabledByFlag && state?.enabled !== true,
      ...(result.ok ? {} : { refused: result.message }),
      ...(warning === undefined ? {} : { warning }),
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    const restored = await restoreModeState(ctx, true);
    if (restored.persist) persistModeState();
    if (restored.warning !== undefined) {
      ctx.ui.notify(restored.warning, "warning");
    }
    if (restored.refused !== undefined) {
      ctx.ui.notify(restored.refused, "error");
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    const restored = await restoreModeState(ctx, false);
    if (restored.warning !== undefined) {
      ctx.ui.notify(restored.warning, "warning");
    }
    if (restored.refused !== undefined) {
      ctx.ui.notify(restored.refused, "error");
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    /**
     * A failed restore is discarded rather than notified here. Pi stops the
     * TUI before it emits this event on the interactive quit path, so a
     * notification would go nowhere. Nothing is lost by staying quiet: the
     * branch still records the model the session started from, so a resumed
     * session carries that record forward and `/swarm off` there restores it,
     * reporting a failure where it can actually be seen.
     */
    await deactivate(ctx);
  });

  /**
   * Resolved from the same agent directory and the same working directory a
   * graph run resolves it from, so the command and the orchestration tool can
   * never disagree about which store they are acting on.
   */
  const resolveStateRoot = async (
    workingDirectory: string,
  ): Promise<string> => {
    const configuration = await loadConfiguration({
      agentDirectory: resolved.getAgentDirectory(),
      workingDirectory,
    });
    return configuration.stateRoot;
  };

  /**
   * Retention cleanup is a command rather than a tool. Deleting a run destroys
   * the diagnostic state it was kept for, so it is an operator's act: the
   * parent model exposes one static orchestration tool and no way to reach
   * this. Both subcommands work whether or not the mode is enabled, because
   * the state they report outlives any one session, and a store that cannot
   * be read or changed is reported rather than thrown at the session.
   */
  const runStore = async (
    ctx: ExtensionCommandContext,
    act: (stateRoot: string) => Promise<string>,
  ): Promise<void> => {
    try {
      ctx.ui.notify(await act(await resolveStateRoot(ctx.cwd)), "info");
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "The run store failed",
        "error",
      );
    }
  };

  pi.registerCommand(SWARM_COMMAND_NAME, {
    description:
      "Enable, disable, or inspect worker-graph orchestration and its run store",
    async handler(args, ctx) {
      const [action = "", ...operands] = args
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0);
      // Operands are checked before the store is touched, so a mistyped
      // invocation answers with its usage and not with a store failure.
      if (action === "runs") {
        if (operands.length !== 0) {
          ctx.ui.notify(SWARM_USAGE, "warning");
          return;
        }
        await runStore(ctx, async (stateRoot) =>
          retainedRunsText(await listRetainedRuns(stateRoot)),
        );
        return;
      }
      if (action === "delete") {
        const [runId] = operands;
        if (runId === undefined || operands.length !== 1) {
          ctx.ui.notify(SWARM_DELETE_USAGE, "warning");
          return;
        }
        await runStore(ctx, async (stateRoot) =>
          (await deleteRun(stateRoot, runId))
            ? `Deleted run ${runId} and released its capacity`
            : `No run ${runId} is retained`,
        );
        return;
      }
      if (action === "on") {
        // Re-entering would reload the configuration and could report "not
        // enabled" for a mode that is enabled and applied. The mode is
        // already what was asked for, so say that instead.
        if (enabled) {
          ctx.ui.notify("Worker-graph mode is already enabled", "info");
          return;
        }
        const activated = await activate(ctx);
        if (!activated.ok) {
          ctx.ui.notify(activated.message, "error");
          return;
        }
        enabled = true;
        persistModeState();
        if (activated.warning !== undefined) {
          ctx.ui.notify(activated.warning, "warning");
        }
        ctx.ui.notify("Worker-graph mode enabled", "info");
      } else if (action === "off") {
        enabled = false;
        const restoreFailed = await deactivate(ctx);
        persistModeState();
        // Reported before the confirmation: leaving the mode on a model the
        // operator did not choose is the more important half of the outcome.
        if (restoreFailed) {
          ctx.ui.notify(MODEL_NOT_RESTORED_MESSAGE, "warning");
        }
        ctx.ui.notify("Worker-graph mode disabled", "info");
      } else if (action === "status") {
        ctx.ui.notify(
          `Worker-graph mode is ${enabled ? "enabled" : "disabled"}${
            appliedOrchestrator === undefined
              ? ""
              : `; the parent is on ${appliedOrchestrator.provider}/${appliedOrchestrator.model} at ${appliedOrchestrator.thinkingLevel} thinking`
          }`,
          "info",
        );
      } else {
        ctx.ui.notify(SWARM_USAGE, "warning");
      }
    },
  });
}
