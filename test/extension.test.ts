import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerWorkerGraph from "../src/extension.js";
import type { NodeOutput } from "../src/index.js";
import {
  acquireRunOwnership,
  createRun,
  NODE_OUTPUT_LIMITS,
  normalizeGraph,
  RUN_COORDINATION_MAX_TEXT_BYTES,
  releaseRunOwnership,
} from "../src/index.js";
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreWorkerRole(value: string | undefined): void {
  restoreEnvironment("PI_WORKER_GRAPH_ROLE", value);
}

const WORKER_ENVIRONMENT = [
  "PI_WORKER_GRAPH_ROLE",
  "PI_WORKER_GRAPH_STATE_ROOT",
  "PI_WORKER_GRAPH_RUN_ID",
  "PI_WORKER_GRAPH_TASK_ID",
] as const;

/** Restores every worker variable the child extension reads. */
function workerEnvironment(t: test.TestContext): void {
  const previous = WORKER_ENVIRONMENT.map(
    (name) => [name, process.env[name]] as const,
  );
  t.after(() => {
    for (const [name, value] of previous) restoreEnvironment(name, value);
  });
}

interface CoordinationTool {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    readonly content: readonly {
      readonly type: string;
      readonly text: string;
    }[];
    readonly details: Record<string, unknown>;
  }>;
}

/**
 * Registers the child extension the way a worker subprocess does: identity and
 * the state directory arrive through the environment, and nothing else. The
 * returned tools are the ones Pi would activate for that worker.
 */
function workerTools(context: {
  readonly stateRoot: string;
  readonly runId: string;
  readonly taskId: string;
}): (name: string) => CoordinationTool {
  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  process.env.PI_WORKER_GRAPH_STATE_ROOT = context.stateRoot;
  process.env.PI_WORKER_GRAPH_RUN_ID = context.runId;
  process.env.PI_WORKER_GRAPH_TASK_ID = context.taskId;
  const registered = new Map<string, CoordinationTool>();
  registerWorkerGraph({
    registerTool(tool: unknown) {
      const definition = tool as CoordinationTool;
      registered.set(definition.name, definition);
    },
  } as never);
  return (name) => {
    const definition = registered.get(name);
    if (!definition) throw new Error(`${name} was not registered`);
    return definition;
  };
}

function coordinationRecords(
  result: { readonly details: Record<string, unknown> },
  field: "events" | "messages",
): readonly Record<string, unknown>[] {
  const records = result.details[field];
  assert.ok(Array.isArray(records));
  return records as readonly Record<string, unknown>[];
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

test("registers child-only coordination tools with a worker context", async (t) => {
  workerEnvironment(t);
  process.env.PI_WORKER_GRAPH_ROLE = "worker";
  process.env.PI_WORKER_GRAPH_STATE_ROOT = "/state/worker-graph";
  process.env.PI_WORKER_GRAPH_RUN_ID = "8a2b0f2c-2c1d-4d1e-9a3f-6b5c4d3e2f10";
  process.env.PI_WORKER_GRAPH_TASK_ID = "sender";
  const registered: string[] = [];
  registerWorkerGraph({
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
  } as never);
  assert.deepEqual(registered, [
    "worker_graph_report",
    "worker_graph_event",
    "worker_graph_events",
    "worker_graph_message",
    "worker_graph_inbox",
  ]);

  // Identity is incomplete without a run, so the coordination tools stay off.
  delete process.env.PI_WORKER_GRAPH_RUN_ID;
  const withoutRun: string[] = [];
  registerWorkerGraph({
    registerTool(tool: { name: string }) {
      withoutRun.push(tool.name);
    },
  } as never);
  assert.deepEqual(withoutRun, ["worker_graph_report"]);
});

test("exchanges directed coordination between two workers", async (t) => {
  workerEnvironment(t);
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-worker-graph-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const manifest = await createRun(
    stateRoot,
    normalizeGraph({ tasks: [{ id: "sender" }, { id: "recipient" }] }),
  );
  const ownership = await acquireRunOwnership(stateRoot, manifest.runId);
  t.after(() => releaseRunOwnership(stateRoot, ownership));
  const runId = manifest.runId;
  // Neither worker holds the ownership capability the orchestrator acquired.
  const sender = workerTools({ stateRoot, runId, taskId: "sender" });
  const recipient = workerTools({ stateRoot, runId, taskId: "recipient" });

  await sender("worker_graph_message").execute("call-1", {
    recipientTaskId: "recipient",
    message: "Consume the shared interface.",
  });
  await sender("worker_graph_event").execute("call-2", {
    eventKind: "interface",
    message: "createClient is stable.",
    symbols: ["createClient"],
    recipients: ["recipient"],
  });
  await sender("worker_graph_event").execute("call-3", {
    eventKind: "progress",
    message: "Unrelated progress.",
  });

  const inbox = await recipient("worker_graph_inbox").execute("call-4", {});
  assert.equal(
    inbox.content[0]?.text.startsWith("UNTRUSTED WORKER COORDINATION DATA"),
    true,
  );
  const delivered = coordinationRecords(inbox, "messages");
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    {
      runId: delivered[0]?.runId,
      senderTaskId: delivered[0]?.senderTaskId,
      recipientTaskId: delivered[0]?.recipientTaskId,
      message: delivered[0]?.message,
    },
    {
      runId,
      senderTaskId: "sender",
      recipientTaskId: "recipient",
      message: "Consume the shared interface.",
    },
  );

  // An inbox is bound to the reading worker, not chosen by it.
  assert.deepEqual(
    coordinationRecords(
      await sender("worker_graph_inbox").execute("call-5", {}),
      "messages",
    ),
    [],
  );

  // Polling with a cursor stays empty until the next handoff arrives.
  const cursor = delivered[0]?.messageId;
  assert.equal(typeof cursor, "string");
  assert.deepEqual(
    coordinationRecords(
      await recipient("worker_graph_inbox").execute("call-6", { cursor }),
      "messages",
    ),
    [],
  );
  await sender("worker_graph_message").execute("call-7", {
    recipientTaskId: "recipient",
    message: "Second handoff.",
  });
  assert.deepEqual(
    coordinationRecords(
      await recipient("worker_graph_inbox").execute("call-8", { cursor }),
      "messages",
    ).map((message) => message.message),
    ["Second handoff."],
  );

  // A worker reads the events it asks for; irrelevant ones are not delivered.
  assert.deepEqual(
    coordinationRecords(
      await recipient("worker_graph_events").execute("call-9", {
        recipient: "recipient",
      }),
      "events",
    ).map((event) => event.message),
    ["createClient is stable."],
  );

  await assert.rejects(
    sender("worker_graph_event").execute("call-10", {
      eventKind: "risk",
      message: "r".repeat(RUN_COORDINATION_MAX_TEXT_BYTES + 1),
    }),
    /invalid or oversized/,
  );
  await assert.rejects(
    sender("worker_graph_message").execute("call-11", {
      recipientTaskId: "missing",
      message: "No such task.",
    }),
    /not in this graph/,
  );
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
