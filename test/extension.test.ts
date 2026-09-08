import assert from "node:assert/strict";
import test from "node:test";
import registerWorkerGraph from "../src/extension.js";
import type { NodeOutput } from "../src/index.js";
import { NODE_OUTPUT_LIMITS } from "../src/index.js";
import { nodeOutput } from "./fixtures.js";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    readonly terminate?: boolean;
    readonly details?: { readonly kind?: string; readonly output?: NodeOutput };
  }>;
}

function captureWorkerTool(): RegisteredTool {
  let definition: RegisteredTool | undefined;
  registerWorkerGraph({
    registerTool(tool: unknown) {
      definition = tool as RegisteredTool;
    },
  } as never);
  if (!definition) throw new Error("Worker tool was not registered");
  return definition;
}

function restoreWorkerRole(value: string | undefined): void {
  if (value === undefined) delete process.env.PI_WORKER_GRAPH_ROLE;
  else process.env.PI_WORKER_GRAPH_ROLE = value;
}

test("keeps the parent graph tool inactive until explicitly enabled", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));

  delete process.env.PI_WORKER_GRAPH_ROLE;
  const tools: string[] = [];
  const commands: string[] = [];
  const flags: string[] = [];
  let active = ["read", "edit", "write"];
  let sessionStart: (() => void) | undefined;
  registerWorkerGraph({
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
      active.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerFlag(name: string) {
      flags.push(name);
    },
    getFlag() {
      return false;
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on(event: string, handler: () => void) {
      if (event === "session_start") sessionStart = handler;
    },
  } as never);
  if (!sessionStart) throw new Error("session_start was not registered");
  assert.deepEqual(active, ["read", "edit", "write", "worker_graph"]);
  sessionStart();
  assert.deepEqual(tools, ["worker_graph"]);
  assert.deepEqual(commands, ["swarm"]);
  assert.deepEqual(flags, ["swarm"]);
  assert.deepEqual(active, ["read", "edit", "write"]);

  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  let workerCommands = 0;
  let workerFlags = 0;
  const workerTools: string[] = [];
  registerWorkerGraph({
    registerTool(tool: { name: string }) {
      workerTools.push(tool.name);
    },
    registerCommand() {
      workerCommands += 1;
    },
    registerFlag() {
      workerFlags += 1;
    },
  } as never);
  assert.deepEqual(workerTools, ["worker_graph_report"]);
  assert.equal(workerCommands, 0);
  assert.equal(workerFlags, 0);
});

test("activates from the startup flag and preserves other tool changes", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));
  delete process.env.PI_WORKER_GRAPH_ROLE;

  let active = ["read", "edit", "worker_graph"];
  let command:
    | ((
        args: string,
        ctx: { ui: { notify(message: string): void } },
      ) => Promise<void>)
    | undefined;
  let sessionStart: (() => void) | undefined;
  const notifications: string[] = [];
  registerWorkerGraph({
    registerTool() {},
    registerFlag() {},
    getFlag() {
      return true;
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on(event: string, handler: () => void) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(
      _name: string,
      options: {
        handler: (
          args: string,
          ctx: { ui: { notify(message: string): void } },
        ) => Promise<void>;
      },
    ) {
      command = options.handler;
    },
  } as never);

  if (!sessionStart) throw new Error("session_start was not registered");
  sessionStart();
  assert.deepEqual(active, ["read", "edit", "worker_graph"]);
  assert.ok(command);
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
  };
  active = ["read", "custom", "worker_graph"];
  await command("off", ctx);
  assert.deepEqual(active, ["read", "custom"]);
  await command("on", ctx);
  assert.deepEqual(active, ["read", "custom", "worker_graph"]);
  await command("status", ctx);
  assert.deepEqual(notifications, [
    "Worker-graph mode disabled",
    "Worker-graph mode enabled",
    "Worker-graph mode is enabled",
  ]);
});

test("registers a terminating final-report tool in worker mode", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));

  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  const definition = captureWorkerTool();
  assert.equal(definition.name, "worker_graph_report");

  const output = {
    ...nodeOutput("Unable to complete"),
    blockers: ["Required service is unavailable"],
  };
  const result = await definition.execute("call-id", output);
  assert.equal(result.terminate, true);
  assert.equal(result.details?.kind, "worker-graph-node-output");
  assert.deepEqual(result.details?.output, output);

  await assert.rejects(
    definition.execute("second-call", nodeOutput()),
    /already submitted/,
  );
});

test("final-report tool defensively validates reports passed to execute", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));
  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  const definition = captureWorkerTool();

  await assert.rejects(
    definition.execute("call-id", {
      ...nodeOutput(),
      transcript: "must not be accepted",
    }),
  );
  await assert.rejects(
    definition.execute("call-id", { ...nodeOutput(), schemaVersion: 2 }),
  );
});

test("lets a worker correct and resubmit a rejected report", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));
  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  const definition = captureWorkerTool();

  // Within `maxLength`, which counts characters, but over the byte limit the
  // parser enforces. The rejection must name the field and the real bound so
  // the worker can shorten it, and must not consume the single submission.
  const oversized = {
    ...nodeOutput(),
    summary: "é".repeat(NODE_OUTPUT_LIMITS.maxTextBytes / 2 + 1),
  };
  await assert.rejects(
    definition.execute("first", oversized),
    /summary.*exceeds 16384 bytes/,
  );

  const corrected = nodeOutput("Shortened to fit the byte budget");
  const result = await definition.execute("second", corrected);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details?.output, corrected);
});

test("publishes the model-facing schema without provider-hostile keywords", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));
  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  const definition = captureWorkerTool();

  // `const` is rejected by some providers' strict function-schema validation.
  assert.equal(
    JSON.stringify(definition.parameters).includes('"const"'),
    false,
  );
  // The byte budgets the parser enforces cannot be expressed in JSON Schema,
  // so they have to be stated where the model can read them.
  assert.match(
    definition.description,
    new RegExp(`${NODE_OUTPUT_LIMITS.maxBytes} bytes`),
  );
  assert.match(
    JSON.stringify(definition.parameters),
    new RegExp(`${NODE_OUTPUT_LIMITS.maxTextBytes} bytes`),
  );
});
