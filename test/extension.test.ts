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

interface SessionContext {
  readonly sessionManager: { getBranch(): readonly unknown[] };
  readonly ui: { notify(message: string, type?: string): void };
}

type SessionHandler = (event: unknown, context: SessionContext) => void;

interface CustomEntry {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

interface Notification {
  readonly message: string;
  readonly type?: string;
}

/**
 * One fake Pi session for the mode tests. Registered tools join the active set
 * the way Pi adds them, and persisted entries accumulate in `entries`, so a
 * session event replays exactly what the extension wrote earlier.
 */
interface ModeSession {
  active: readonly string[];
  readonly tools: string[];
  readonly commands: string[];
  readonly flags: string[];
  readonly entries: CustomEntry[];
  readonly notifications: Notification[];
  start(entries?: readonly unknown[]): void;
  tree(entries?: readonly unknown[]): void;
  shutdown(): void;
  swarm(action: string): Promise<void>;
}

function modeSession(
  options: {
    readonly active?: readonly string[];
    readonly flag?: boolean;
  } = {},
): ModeSession {
  const handlers = new Map<string, SessionHandler>();
  let swarmCommand:
    | ((args: string, ctx: SessionContext) => Promise<void>)
    | undefined;
  const notify = (message: string, type?: string) => {
    session.notifications.push({
      message,
      ...(type === undefined ? {} : { type }),
    });
  };
  const context = (entries?: readonly unknown[]): SessionContext => ({
    sessionManager: { getBranch: () => entries ?? session.entries },
    ui: { notify },
  });
  const fire = (event: string, entries?: readonly unknown[]) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`${event} was not registered`);
    handler({}, context(entries));
  };
  const session: ModeSession = {
    active: [...(options.active ?? ["read", "bash", "edit", "write"])],
    tools: [],
    commands: [],
    flags: [],
    entries: [],
    notifications: [],
    start: (entries) => fire("session_start", entries),
    tree: (entries) => fire("session_tree", entries),
    shutdown: () => fire("session_shutdown"),
    async swarm(action) {
      if (!swarmCommand) throw new Error("/swarm was not registered");
      await swarmCommand(action, context());
    },
  };
  registerWorkerGraph({
    registerTool(tool: { name: string }) {
      session.tools.push(tool.name);
      session.active = [...session.active, tool.name];
    },
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: SessionContext) => Promise<void>;
      },
    ) {
      session.commands.push(name);
      swarmCommand = definition.handler;
    },
    registerFlag(name: string) {
      session.flags.push(name);
    },
    getFlag() {
      return options.flag === true;
    },
    getActiveTools() {
      return [...session.active];
    },
    setActiveTools(names: string[]) {
      session.active = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      session.entries.push({ type: "custom", customType, data });
    },
    on(event: string, handler: SessionHandler) {
      handlers.set(event, handler);
    },
  } as never);
  return session;
}

function modeEntry(
  enabled: boolean,
  toolsBeforeMode?: readonly string[],
): CustomEntry {
  return {
    type: "custom",
    customType: "worker-graph-mode",
    data: {
      schemaVersion: 1,
      enabled,
      ...(toolsBeforeMode === undefined ? {} : { toolsBeforeMode }),
    },
  };
}

/** Clears the worker role so the extension registers its parent surface. */
function parentSession(t: test.TestContext): void {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));
  delete process.env.PI_WORKER_GRAPH_ROLE;
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
  parentSession(t);
  const session = modeSession({ active: ["read", "edit", "write"] });

  assert.deepEqual(session.active, ["read", "edit", "write", "worker_graph"]);
  session.start();
  assert.deepEqual(session.tools, ["worker_graph"]);
  assert.deepEqual(session.commands, ["swarm"]);
  assert.deepEqual(session.flags, ["swarm"]);
  assert.deepEqual(session.active, ["read", "edit", "write"]);

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

test("startup mode suppresses parent write tools and restores its snapshot", async (t) => {
  parentSession(t);
  const session = modeSession({ flag: true });
  const suppressed = ["read", "bash", "edit", "write"];

  session.start();
  assert.deepEqual(session.active, ["read", "worker_graph"]);

  session.active = ["read", "custom", "worker_graph"];
  await session.swarm("off");
  assert.deepEqual(session.active, suppressed);
  await session.swarm("on");
  assert.deepEqual(session.active, ["read", "worker_graph"]);
  await session.swarm("status");

  assert.deepEqual(session.entries, [
    modeEntry(true, suppressed),
    modeEntry(false),
    modeEntry(true, suppressed),
  ]);
  assert.deepEqual(session.notifications, [
    { message: "Worker-graph mode disabled", type: "info" },
    { message: "Worker-graph mode enabled", type: "info" },
    { message: "Worker-graph mode is enabled", type: "info" },
  ]);

  session.shutdown();
  assert.deepEqual(session.active, suppressed);
});

test("restores branch-scoped mode state on resume and tree navigation", async (t) => {
  parentSession(t);
  const session = modeSession();
  const enabled = modeEntry(true, ["read", "bash", "edit", "write", "custom"]);

  session.start([enabled]);
  assert.deepEqual(session.active, ["read", "custom", "worker_graph"]);

  session.tree([enabled, modeEntry(false)]);
  assert.deepEqual(session.active, ["read", "bash", "edit", "write", "custom"]);
});

test("the startup flag does not undo an explicit off across the session tree", async (t) => {
  parentSession(t);
  const session = modeSession({ flag: true });
  const suppressed = ["read", "bash", "edit", "write"];

  session.start();
  assert.deepEqual(session.active, ["read", "worker_graph"]);

  await session.swarm("off");
  assert.deepEqual(session.active, suppressed);

  session.tree();
  assert.deepEqual(session.active, suppressed);

  session.start();
  assert.deepEqual(session.active, ["read", "worker_graph"]);
});

test("refuses to enable a mode whose tool snapshot could not be restored", async (t) => {
  parentSession(t);
  const unrestorable = ["read", "bash", `wide-${"t".repeat(300)}`];
  const session = modeSession({ active: unrestorable, flag: true });
  const refusal = {
    message:
      "Worker-graph mode not enabled: the active tool set cannot be restored later",
    type: "error",
  };

  session.start();
  assert.deepEqual(session.active, unrestorable);

  await session.swarm("on");
  assert.deepEqual(session.active, unrestorable);
  assert.deepEqual(session.entries, []);

  await session.swarm("status");
  assert.deepEqual(session.notifications, [
    refusal,
    refusal,
    { message: "Worker-graph mode is disabled", type: "info" },
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
