import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  registerWorkerGraphOrchestratorTool,
  WORKER_GRAPH_TOOL_NAME,
  type WorkerGraphOrchestratorDependencies,
} from "./orchestrator.js";
import {
  NODE_OUTPUT_LIMITS,
  NODE_OUTPUT_SCHEMA_VERSION,
  parseNodeOutput,
} from "./output.js";

const WORKER_ROLE_VARIABLE = "PI_WORKER_GRAPH_ROLE";
const WORKER_ROLE = "worker";
export const WORKER_REPORT_TOOL_NAME = "worker_graph_report";
export const SWARM_COMMAND_NAME = "swarm";
export const SWARM_FLAG_NAME = "swarm";

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

const nodeOutputSchema = Type.Object(
  {
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
    ].join(" "),
    promptSnippet: "Submit the final worker report and end the task",
    promptGuidelines: [
      "Use worker_graph_report exactly once as the final action after completing or blocking the assigned task.",
      "Report blockers honestly; do not claim success when required work or validation is incomplete.",
      `Keep the whole report within ${NODE_OUTPUT_LIMITS.maxBytes} bytes by summarizing rather than pasting file contents or command transcripts.`,
    ],
    parameters: nodeOutputSchema,
    async execute(_toolCallId, params) {
      if (submitted)
        throw new Error("A final worker report was already submitted");
      // Thrown validation errors reach the model as a tool error, so the
      // message must say what to change. The parent treats a rejected report
      // as recoverable and waits for a corrected resubmission.
      const output = parseNodeOutput(params);
      submitted = true;
      return {
        content: [{ type: "text", text: "Final worker report submitted." }],
        details: {
          kind: "worker-graph-node-output",
          output,
        },
        terminate: true,
      };
    },
  });
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
  };
}

/** Pi package entry point with mutually exclusive worker and parent roles. */
export default function registerWorkerGraph(
  pi: ExtensionAPI,
  dependencies: Partial<WorkerGraphOrchestratorDependencies> = {},
): void {
  if (process.env[WORKER_ROLE_VARIABLE] === WORKER_ROLE) {
    registerWorkerReportTool(pi);
    return;
  }

  pi.registerFlag(SWARM_FLAG_NAME, {
    description: "Start with worker-graph orchestration enabled",
    type: "boolean",
    default: false,
  });
  registerWorkerGraphOrchestratorTool(
    pi,
    orchestratorDependencies(dependencies),
  );

  let enabled = false;
  const activate = () => {
    const active = pi.getActiveTools();
    if (active.includes(WORKER_GRAPH_TOOL_NAME)) return;
    pi.setActiveTools([...active, WORKER_GRAPH_TOOL_NAME]);
  };
  const deactivate = () => {
    const active = pi.getActiveTools();
    if (!active.includes(WORKER_GRAPH_TOOL_NAME)) return;
    pi.setActiveTools(active.filter((name) => name !== WORKER_GRAPH_TOOL_NAME));
  };

  pi.on("session_start", () => {
    enabled = pi.getFlag(SWARM_FLAG_NAME) === true;
    if (enabled) activate();
    else deactivate();
  });

  pi.registerCommand(SWARM_COMMAND_NAME, {
    description: "Enable, disable, or inspect worker-graph orchestration",
    async handler(args, ctx) {
      const action = args.trim();
      if (action === "on") {
        enabled = true;
        activate();
        ctx.ui.notify("Worker-graph mode enabled", "info");
      } else if (action === "off") {
        enabled = false;
        deactivate();
        ctx.ui.notify("Worker-graph mode disabled", "info");
      } else if (action === "status") {
        ctx.ui.notify(
          `Worker-graph mode is ${enabled ? "enabled" : "disabled"}`,
          "info",
        );
      } else {
        ctx.ui.notify("Usage: /swarm on|status|off", "warning");
      }
    },
  });
}
