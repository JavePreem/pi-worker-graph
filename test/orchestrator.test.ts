import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  registerWorkerGraphOrchestratorTool,
  WORKER_GRAPH_TOOL_NAME,
} from "../src/orchestrator.js";
import type { PiSubprocessExecutorOptions } from "../src/pi-subprocess.js";
import type { TaskExecutor } from "../src/run.js";
import { nodeOutput } from "./fixtures.js";

interface RegisteredTool {
  readonly name: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    context: { readonly cwd: string },
  ) => Promise<{
    readonly content: readonly {
      readonly type: string;
      readonly text: string;
    }[];
    readonly details: {
      readonly kind: string;
      readonly runId: string;
      readonly status: string;
      readonly nodes: readonly {
        readonly taskId: string;
        readonly status: string;
      }[];
      readonly usage: { readonly turns: number; readonly input: number };
    };
    readonly usage: {
      readonly input: number;
      readonly output: number;
      readonly totalTokens: number;
    };
  }>;
}

async function fixture(t: test.TestContext): Promise<{
  readonly root: string;
  readonly agentDirectory: string;
  readonly workingDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-graph-tool-"));
  const agentDirectory = join(root, "agent");
  const workingDirectory = join(root, "checkout");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(
    join(agentDirectory, "worker-graph.json"),
    JSON.stringify({
      schemaVersion: 1,
      stateRoot: "state",
      profiles: {
        writer: {
          provider: "test-provider",
          model: "test-model",
          thinkingLevel: "medium",
          tools: ["read", "edit", "write"],
        },
      },
    }),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, agentDirectory, workingDirectory };
}

function captureTool(
  agentDirectory: string,
  createExecutor: (options: PiSubprocessExecutorOptions) => TaskExecutor,
): RegisteredTool {
  let tool: RegisteredTool | undefined;
  registerWorkerGraphOrchestratorTool(
    {
      registerTool(definition: unknown) {
        tool = definition as RegisteredTool;
      },
    } as never,
    { getAgentDirectory: () => agentDirectory, createExecutor },
  );
  if (!tool) throw new Error("worker_graph was not registered");
  return tool;
}

test("runs a configured graph and returns bounded status plus nested usage", async (t) => {
  const paths = await fixture(t);
  const executed: string[] = [];
  const assignmentSecret = "assignment content must not enter progress";
  const tool = captureTool(paths.agentDirectory, (options) => {
    assert.deepEqual(options.profiles.writer, {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "medium",
      tools: ["edit", "read", "write"],
    });
    return async (input) => {
      executed.push(input.taskId);
      options.onProgress?.({
        taskId: input.taskId,
        phase: "started",
        usage: {
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      });
      options.onProgress?.({
        taskId: input.taskId,
        phase: "finished",
        status: "succeeded",
        usage: {
          turns: 1,
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.002,
            cacheWrite: 0.001,
            total: 0.033,
          },
        },
      });
      return { output: nodeOutput(`Completed ${input.taskId}`) };
    };
  });
  assert.equal(tool.name, WORKER_GRAPH_TOOL_NAME);

  const updates: unknown[] = [];
  const result = await tool.execute(
    "call-id",
    {
      tasks: [
        {
          id: "implementation",
          profile: "writer",
          assignment: assignmentSecret,
        },
        {
          id: "validation",
          needs: ["implementation"],
          profile: "writer",
          assignment: "Validate the implementation",
        },
      ],
      concurrency: 2,
      taskTimeoutMs: 5_000,
    },
    undefined,
    (update) => updates.push(update),
    { cwd: paths.workingDirectory },
  );

  assert.deepEqual(executed, ["implementation", "validation"]);
  assert.match(result.content[0]?.text ?? "", /Worker graph succeeded/);
  assert.deepEqual(result.details.nodes, [
    { taskId: "implementation", status: "succeeded" },
    { taskId: "validation", status: "succeeded" },
  ]);
  assert.equal(result.details.usage.turns, 2);
  assert.equal(result.details.usage.input, 20);
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.output, 10);
  assert.equal(result.usage.totalTokens, 36);
  assert.ok(updates.length > 0);
  assert.equal(JSON.stringify(updates).includes(assignmentSecret), false);
});

test("rejects an invalid complete graph before executing a worker", async (t) => {
  const paths = await fixture(t);
  let executions = 0;
  const tool = captureTool(paths.agentDirectory, () => async () => {
    executions += 1;
    return { output: nodeOutput() };
  });

  await assert.rejects(() =>
    tool.execute(
      "call-id",
      {
        tasks: [
          { id: "same", profile: "writer", assignment: "First" },
          { id: "same", profile: "writer", assignment: "Second" },
        ],
      },
      undefined,
      undefined,
      { cwd: paths.workingDirectory },
    ),
  );

  assert.equal(executions, 0);
});

test("defensively rejects unknown request fields before loading configuration", async () => {
  let configurationLoads = 0;
  let tool: RegisteredTool | undefined;
  registerWorkerGraphOrchestratorTool(
    {
      registerTool(definition: unknown) {
        tool = definition as RegisteredTool;
      },
    } as never,
    {
      getAgentDirectory: () => "/agent",
      async loadConfiguration() {
        configurationLoads += 1;
        throw new Error("must not load");
      },
    },
  );
  const registered = tool;
  if (!registered) throw new Error("worker_graph was not registered");

  await assert.rejects(
    () =>
      registered.execute(
        "call-id",
        {
          tasks: [{ id: "task", profile: "writer", assignment: "Work" }],
          transcript: "not allowed",
        },
        undefined,
        undefined,
        { cwd: "/checkout" },
      ),
    /Invalid worker_graph request/,
  );
  assert.equal(configurationLoads, 0);
});

test("passes parent cancellation into the graph runner", async (t) => {
  const paths = await fixture(t);
  const controller = new AbortController();
  let observedAbort = false;
  const tool = captureTool(
    paths.agentDirectory,
    () => (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({ output: nodeOutput("Stopped") });
          },
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      }),
  );

  const result = await tool.execute(
    "call-id",
    { tasks: [{ id: "task", profile: "writer", assignment: "Work" }] },
    controller.signal,
    undefined,
    { cwd: paths.workingDirectory },
  );

  assert.equal(observedAbort, true);
  assert.equal(result.details.status, "aborted");
  assert.deepEqual(result.details.nodes, [
    { taskId: "task", status: "aborted" },
  ]);
});

test("caps parent tool updates while retaining the latest usage", async (t) => {
  const paths = await fixture(t);
  const tool = captureTool(paths.agentDirectory, (options) => async (input) => {
    for (let index = 0; index < 400; index += 1) {
      options.onProgress?.({
        taskId: input.taskId,
        phase: "turn_completed",
        usage: {
          turns: index + 1,
          input: index + 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: index + 1,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      });
    }
    return { output: nodeOutput() };
  });
  let updates = 0;

  const result = await tool.execute(
    "call-id",
    { tasks: [{ id: "task", profile: "writer", assignment: "Work" }] },
    undefined,
    () => {
      updates += 1;
    },
    { cwd: paths.workingDirectory },
  );

  assert.equal(updates, 256);
  assert.equal(result.details.usage.turns, 400);
  assert.equal(result.usage.input, 400);
});
