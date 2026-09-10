import assert from "node:assert/strict";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TaskExecutionFailure } from "../src/execution-failure.js";
import type {
  NodeOutput,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../src/index.js";
import {
  createPiSubprocessExecutor,
  NODE_OUTPUT_LIMITS,
} from "../src/index.js";
import type {
  PiSubprocessExecutorOptions,
  PiWorkerProfile,
} from "../src/pi-subprocess.js";
import { runPiWorkerProcess } from "../src/pi-subprocess.js";
import { nodeOutput } from "./fixtures.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12_345;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  close(code: number): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

function input(
  signal: AbortSignal,
  payload: TaskExecutionInput["payload"] = {
    assignment: "Implement the requested change",
    profile: "writer",
    acceptanceCriteria: ["Tests pass"],
    expectedPaths: ["src/example.ts"],
  },
): TaskExecutionInput {
  return {
    runId: "run-id",
    taskId: "task-id",
    payload,
    workingDirectory: "/target/checkout",
    prerequisites: [],
    prerequisiteContext: "DIRECT CONTEXT",
    signal,
  };
}

const options: PiSubprocessExecutorOptions = {
  profiles: {
    writer: {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "medium",
      tools: ["write", "read", "edit"],
    },
  },
  command: "/usr/local/bin/pi",
  extensionPath: "/package/extensions/index.ts",
};

function reportEvent(output: NodeOutput, artifact?: unknown): string {
  return JSON.stringify({
    type: "tool_execution_end",
    toolName: "worker_graph_report",
    isError: false,
    result: {
      content: [{ type: "text", text: "Final worker report submitted." }],
      details: {
        kind: "worker-graph-node-output",
        output,
        ...(artifact === undefined ? {} : { artifact }),
      },
    },
  });
}

function assistantBatchEvent(...toolNames: readonly string[]): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Working." },
        ...toolNames.map((name, index) => ({
          type: "toolCall",
          id: `call-${index}`,
          name,
          arguments: {},
        })),
      ],
    },
  });
}

function toolEvent(toolName: string): string {
  return JSON.stringify({
    type: "tool_execution_end",
    toolName,
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
  });
}

async function runFakeWorker(
  lines: readonly string[],
  exitCode = 0,
): Promise<TaskExecutionResult> {
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(lines.map((line) => `${line}\n`).join(""));
      child.close(exitCode);
    });
  });
  return runPiWorkerProcess(input(new AbortController().signal), options, {
    spawnProcess: (() =>
      child as unknown as ChildProcessWithoutNullStreams) as never,
    terminateProcessTree: () => {},
  });
}

test("spawns an isolated Pi worker and sends task content only through stdin", async () => {
  const child = new FakeChild();
  let prompt = "";
  const cleanupForces: boolean[] = [];
  let invocation:
    | { command: string; args: readonly string[]; options: SpawnOptions }
    | undefined;
  child.stdin.on("data", (chunk) => {
    prompt += chunk.toString();
  });
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput("Completed task"))}\n`);
      child.close(0);
    });
  });

  const result = await runPiWorkerProcess(
    input(new AbortController().signal),
    options,
    {
      spawnProcess: ((
        command: string,
        args: readonly string[],
        spawnOptions: SpawnOptions,
      ) => {
        invocation = { command, args, options: spawnOptions };
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      terminateProcessTree: (_child, force) => cleanupForces.push(force),
    },
  );

  assert.deepEqual(result, { output: nodeOutput("Completed task") });
  assert.deepEqual(cleanupForces, [true]);
  assert.ok(invocation);
  assert.equal(invocation.command, "/usr/local/bin/pi");
  assert.equal(invocation.options.cwd, "/target/checkout");
  assert.equal(invocation.options.shell, false);
  const environment = invocation.options.env as NodeJS.ProcessEnv;
  assert.equal(environment.PI_WORKER_GRAPH_ROLE, "worker");
  for (const name of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    "PI_WORKER_GRAPH_STATE_ROOT",
    "PI_WORKER_GRAPH_RUN_ID",
    "PI_WORKER_GRAPH_TASK_ID",
    "PI_WORKER_GRAPH_OWNER_ID",
  ]) {
    assert.equal(environment[name], undefined);
  }
  assert.deepEqual(invocation.args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--extension",
    "/package/extensions/index.ts",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--provider",
    "test-provider",
    "--model",
    "test-model",
    "--thinking",
    "medium",
    "--tools",
    "edit,read,write,worker_graph_report",
  ]);
  assert.equal(prompt.includes("worker_graph_event"), false);
  // The concurrency contract is instruction the worker only ever receives
  // here: the runtime performs no Git operations itself, so nothing else
  // stops a worker that holds `bash` from resetting the shared checkout.
  for (const contract of [
    "Preserve concurrent changes and re-read files before editing",
    "Never run git restore, reset, checkout, stash, or clean",
    "never commit, push, or create a branch",
    "Do not run repository-wide formatters, code generators, or dependency updates",
    "Prefer small exact edits",
    "Re-read every file you changed before reporting",
    "report the conflict as a blocker",
  ]) {
    assert.equal(prompt.includes(contract), true, contract);
  }
  const argumentsText = invocation.args.join(" ");
  for (const sensitive of [
    "Implement the requested change",
    "Tests pass",
    "src/example.ts",
    "DIRECT CONTEXT",
    "run-id",
    "task-id",
  ]) {
    assert.equal(argumentsText.includes(sensitive), false);
    assert.equal(prompt.includes(sensitive), true);
  }
});

test("gives a coordinating worker run identity but no ownership capability", async () => {
  const child = new FakeChild();
  let prompt = "";
  let invocation:
    | { command: string; args: readonly string[]; options: SpawnOptions }
    | undefined;
  child.stdin.on("data", (chunk) => {
    prompt += chunk.toString();
  });
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput("Completed task"))}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(
    {
      ...input(new AbortController().signal),
      runStateRoot: "/state/worker-graph",
    },
    options,
    {
      spawnProcess: ((
        command: string,
        args: readonly string[],
        spawnOptions: SpawnOptions,
      ) => {
        invocation = { command, args, options: spawnOptions };
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.ok(invocation);
  const environment = invocation.options.env as NodeJS.ProcessEnv;
  assert.equal(environment.PI_WORKER_GRAPH_STATE_ROOT, "/state/worker-graph");
  assert.equal(environment.PI_WORKER_GRAPH_RUN_ID, "run-id");
  assert.equal(environment.PI_WORKER_GRAPH_TASK_ID, "task-id");
  assert.equal(environment.PI_WORKER_GRAPH_OWNER_ID, undefined);
  // Pi's tool allowlist covers extension tools, so the coordination tools are
  // only callable when they are named here.
  assert.equal(
    invocation.args[invocation.args.indexOf("--tools") + 1],
    [
      "edit,read,write",
      "worker_graph_report",
      "worker_graph_event",
      "worker_graph_events",
      "worker_graph_message",
      "worker_graph_inbox",
    ].join(","),
  );
  assert.equal(prompt.includes("worker_graph_event"), true);
});

test("fails a worker that exits without the final-report tool", async () => {
  const child = new FakeChild();
  child.stdin.on("finish", () => queueMicrotask(() => child.close(0)));

  await assert.rejects(
    runPiWorkerProcess(input(new AbortController().signal), options, {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionFailure);
      assert.equal(error.code, "missing_report");
      return true;
    },
  );
});

test("maps provider, report-tool, protocol, and process failures", async () => {
  const cases = [
    {
      line: JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      }),
      exitCode: 1,
      expected: "provider",
    },
    {
      line: JSON.stringify({
        type: "tool_execution_end",
        toolName: "worker_graph_report",
        isError: true,
      }),
      exitCode: 0,
      expected: "report_tool",
    },
    { line: "{invalid", exitCode: 0, expected: "protocol" },
    {
      line: JSON.stringify({
        type: "tool_execution_end",
        toolName: "worker_graph_report",
        isError: false,
        result: { details: { kind: "unexpected-envelope" } },
      }),
      exitCode: 0,
      expected: "report_tool",
    },
    { line: "", exitCode: 1, expected: "process" },
  ] as const;

  for (const testCase of cases) {
    const child = new FakeChild();
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        if (testCase.line) child.stdout.end(`${testCase.line}\n`);
        child.close(testCase.exitCode);
      });
    });

    await assert.rejects(
      runPiWorkerProcess(input(new AbortController().signal), options, {
        spawnProcess: (() =>
          child as unknown as ChildProcessWithoutNullStreams) as never,
        terminateProcessTree: () => {},
        terminationGraceMs: 1,
      }),
      (error: unknown) =>
        error instanceof TaskExecutionFailure &&
        error.code === testCase.expected,
    );
  }

  await assert.rejects(
    runPiWorkerProcess(input(new AbortController().signal), options, {
      spawnProcess: (() => {
        throw new Error("startup secret");
      }) as never,
    }),
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "startup",
  );
});

test("terminates the worker process tree when cancelled", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const terminations: boolean[] = [];
  const execution = runPiWorkerProcess(input(controller.signal), options, {
    spawnProcess: (() =>
      child as unknown as ChildProcessWithoutNullStreams) as never,
    terminateProcessTree: (_child, force) => {
      terminations.push(force);
      if (!force) queueMicrotask(() => child.close(143));
    },
    terminationGraceMs: 10,
  });

  controller.abort();
  await assert.rejects(execution, TaskExecutionFailure);
  assert.deepEqual(terminations, [false, true]);
});

test("forces process-tree termination after the graceful deadline", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const terminations: boolean[] = [];
  const execution = runPiWorkerProcess(input(controller.signal), options, {
    spawnProcess: (() =>
      child as unknown as ChildProcessWithoutNullStreams) as never,
    terminateProcessTree: (_child, force) => {
      terminations.push(force);
      if (force) queueMicrotask(() => child.close(137));
    },
    terminationGraceMs: 10,
  });

  controller.abort();
  await assert.rejects(execution, TaskExecutionFailure);
  assert.deepEqual(terminations, [false, true]);
});

test("rejects invalid profiles and assignments before spawning", async () => {
  let spawned = false;
  const spawnProcess = (() => {
    spawned = true;
    return new FakeChild() as unknown as ChildProcessWithoutNullStreams;
  }) as never;

  await assert.rejects(
    runPiWorkerProcess(
      input(new AbortController().signal, {
        assignment: "work",
        profile: "missing",
      }),
      options,
      { spawnProcess },
    ),
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "invalid_profile",
  );
  await assert.rejects(
    runPiWorkerProcess(
      input(new AbortController().signal),
      {
        ...options,
        profiles: {
          writer: {
            provider: "test-provider",
            model: "test-model",
            thinkingLevel: "medium",
            tools: ["subagent" as never],
          },
        },
      },
      { spawnProcess },
    ),
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "invalid_profile",
  );
  await assert.rejects(
    runPiWorkerProcess(
      input(new AbortController().signal, {
        assignment: "x".repeat(64 * 1024),
        profile: "writer",
      }),
      options,
      { spawnProcess },
    ),
    (error: unknown) =>
      error instanceof TaskExecutionFailure &&
      error.code === "invalid_assignment",
  );

  const executor = createPiSubprocessExecutor(options);
  assert.throws(
    () =>
      executor.validateTasks?.([
        {
          id: "first",
          payload: { assignment: "valid", profile: "writer" },
        },
        {
          id: "second",
          payload: { assignment: "invalid", profile: "missing" },
        },
      ]),
    (error: unknown) =>
      error instanceof TaskExecutionFailure &&
      error.code === "invalid_profile" &&
      error.taskId === "second",
  );
  assert.equal(spawned, false);
});

test("accepts a report after a large transcript and a rejected attempt", async () => {
  const child = new FakeChild();
  const output = nodeOutput("Completed after correcting the report");
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      // A single event line far above the framing bound: a real worker's tool
      // results and end-of-session message arrays reach this size, and must
      // not be mistaken for a runaway child.
      child.stdout.write(
        `${JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false, result: "y".repeat(4 * 1024 * 1024) })}\n`,
      );
      // The worker's first report was rejected, then corrected.
      child.stdout.write(
        `${JSON.stringify({ type: "tool_execution_end", toolName: "worker_graph_report", isError: true })}\n`,
      );
      child.stdout.end(`${reportEvent(output)}\n`);
      child.close(0);
    });
  });

  const result = await runPiWorkerProcess(
    input(new AbortController().signal),
    options,
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.deepEqual(result, { output });
});

test("reports a truncated oversized line as a missing report", async () => {
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      // An oversized line the child never finished writing. Skipping it must
      // leave the task reported as unreported work, not as a protocol breach
      // the child never committed.
      child.stdout.write(
        `${JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false, result: "y".repeat(4 * 1024 * 1024) })}`,
      );
      child.stdout.end("trailing fragment with no newline");
      child.close(0);
    });
  });

  await assert.rejects(
    runPiWorkerProcess(input(new AbortController().signal), options, {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    }),
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "missing_report",
  );
});

test("keeps a captured report when the child exits badly afterwards", async () => {
  const output = nodeOutput("Completed before the child died");
  for (const epilogue of [
    { exitCode: 1, line: undefined },
    {
      exitCode: 0,
      line: JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      }),
    },
  ] as const) {
    const child = new FakeChild();
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        child.stdout.write(`${reportEvent(output)}\n`);
        if (epilogue.line) child.stdout.write(`${epilogue.line}\n`);
        child.stdout.end();
        child.stdin.emit("error", new Error("EPIPE"));
        child.close(epilogue.exitCode);
      });
    });

    const result = await runPiWorkerProcess(
      input(new AbortController().signal),
      options,
      {
        spawnProcess: (() =>
          child as unknown as ChildProcessWithoutNullStreams) as never,
        terminateProcessTree: () => {},
      },
    );

    assert.deepEqual(result, { output });
  }
});

test("fails a worker whose only report attempts were rejected", async () => {
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(
        `${JSON.stringify({ type: "tool_execution_end", toolName: "worker_graph_report", isError: true })}\n`,
      );
      child.close(0);
    });
  });

  await assert.rejects(
    runPiWorkerProcess(input(new AbortController().signal), options, {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    }),
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "report_tool",
  );
});

test("discards a report produced by a cancelled worker", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const execution = runPiWorkerProcess(input(controller.signal), options, {
    spawnProcess: (() =>
      child as unknown as ChildProcessWithoutNullStreams) as never,
    terminateProcessTree: (_child, force) => {
      if (force) return;
      queueMicrotask(() => {
        child.stdout.end(`${reportEvent(nodeOutput("Raced the abort"))}\n`);
        child.close(0);
      });
    },
    terminationGraceMs: 10,
  });

  controller.abort();
  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof TaskExecutionFailure && error.code === "process",
  );
});

test("spawns the worker as its own process-group leader on POSIX", async () => {
  const child = new FakeChild();
  let spawnOptions: SpawnOptions | undefined;
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(input(new AbortController().signal), options, {
    spawnProcess: ((
      _command: string,
      _args: readonly string[],
      received: SpawnOptions,
    ) => {
      spawnOptions = received;
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as never,
    terminateProcessTree: () => {},
  });

  assert.equal(spawnOptions?.detached, process.platform !== "win32");
});

test("reassembles event lines split mid-character across chunks", async () => {
  const child = new FakeChild();
  const output = nodeOutput("Résumé aktualisiert ✅");
  const encoded = Buffer.from(`${reportEvent(output)}\n`, "utf8");
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      // Split inside the multi-byte summary so neither chunk decodes alone.
      const split = encoded.indexOf(Buffer.from("é", "utf8")) + 1;
      child.stdout.write(encoded.subarray(0, split));
      child.stdout.end(encoded.subarray(split));
      child.close(0);
    });
  });

  const result = await runPiWorkerProcess(
    input(new AbortController().signal),
    options,
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.deepEqual(result, { output });
});

test("rejects a report the worker did not make its final action", async () => {
  const output = nodeOutput("Reported while still working");

  // Pi runs the tool calls of one assistant message as a batch, and
  // `terminate: true` only ends the session when every result in the batch
  // terminates. A report sharing its batch leaves the worker running.
  await assert.rejects(
    runFakeWorker([
      assistantBatchEvent("worker_graph_report", "write"),
      reportEvent(output),
      toolEvent("write"),
    ]),
    (error: unknown) =>
      error instanceof TaskExecutionFailure &&
      error.code === "report_not_final",
  );

  // Even a sole-call batch is not final if the worker went on to another turn.
  await assert.rejects(
    runFakeWorker([
      assistantBatchEvent("worker_graph_report"),
      reportEvent(output),
      assistantBatchEvent("bash"),
      toolEvent("bash"),
    ]),
    (error: unknown) =>
      error instanceof TaskExecutionFailure &&
      error.code === "report_not_final",
  );
});

test("accepts a report that was the sole call of its final batch", async () => {
  const output = nodeOutput("Reported as the final action");

  assert.deepEqual(
    await runFakeWorker([
      assistantBatchEvent("read", "grep"),
      toolEvent("read"),
      toolEvent("grep"),
      assistantBatchEvent("worker_graph_report"),
      reportEvent(output),
    ]),
    { output },
  );
});

test("projects bounded progress and usage without forwarding worker content", async () => {
  const child = new FakeChild();
  const progress: unknown[] = [];
  const secret = "provider transcript secret";
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: secret },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "tool_execution_end",
          toolName: "read",
          isError: false,
          result: { content: [{ type: "text", text: secret }] },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "text", text: secret }],
            usage: {
              input: 10,
              output: 4,
              cacheRead: 3,
              cacheWrite: 2,
              totalTokens: 19,
              cost: {
                input: 0.01,
                output: 0.02,
                cacheRead: 0.003,
                cacheWrite: 0.004,
                total: 0.037,
              },
            },
          },
        })}\n`,
      );
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(
    input(new AbortController().signal),
    {
      ...options,
      onProgress: (update) => progress.push(update),
    },
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.deepEqual(
    progress.map((value) => (value as { phase: string }).phase),
    [
      "started",
      "tool_started",
      "tool_completed",
      "turn_completed",
      "tool_completed",
      "finished",
    ],
  );
  const terminal = progress.at(-1) as {
    status: string;
    usage: { turns: number; totalTokens: number; cost: { total: number } };
  };
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.usage.turns, 1);
  assert.equal(terminal.usage.totalTokens, 19);
  assert.equal(terminal.usage.cost.total, 0.037);
  assert.equal(JSON.stringify(progress).includes(secret), false);
  assert.ok(Object.isFrozen(terminal.usage));
  assert.ok(Object.isFrozen(terminal.usage.cost));
});

test("captures delta-event usage when an oversized final message is skipped", async () => {
  const child = new FakeChild();
  const progress: Array<{ phase: string; usage: { totalTokens: number } }> = [];
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "message_update",
          usage: {
            input: 7,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "worker text is ignored",
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }],
          },
        })}\n`,
      );
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(
    input(new AbortController().signal),
    {
      ...options,
      onProgress: (update) => progress.push(update),
    },
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.equal(progress.at(-1)?.usage.totalTokens, 10);
  assert.equal(
    progress.filter((update) => update.phase === "turn_completed").length,
    1,
  );
});

test("caps progress callbacks and reserves a terminal update", async () => {
  const child = new FakeChild();
  const phases: string[] = [];
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      for (let index = 0; index < 400; index += 1) {
        child.stdout.write(
          `${JSON.stringify({
            type: "tool_execution_start",
            toolName: "read",
            args: { index },
          })}\n`,
        );
      }
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(
    input(new AbortController().signal),
    {
      ...options,
      onProgress: (update) => phases.push(update.phase),
    },
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.equal(phases.length, 256);
  assert.equal(phases.at(-1), "finished");
});

test("ignores progress observer failures", async () => {
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  const result = await runPiWorkerProcess(
    input(new AbortController().signal),
    {
      ...options,
      onProgress: () => {
        throw new Error("observer failure");
      },
    },
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.deepEqual(result, { output: nodeOutput() });
});

test("resolves the worker command without a shell on every platform", async () => {
  const child = new FakeChild();
  let invocation: { command: string; args: readonly string[] } | undefined;
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput())}\n`);
      child.close(0);
    });
  });

  await runPiWorkerProcess(
    input(new AbortController().signal),
    // No `command`, so the adapter has to resolve Pi itself.
    { profiles: options.profiles, extensionPath: "/package/extensions/x.ts" },
    {
      spawnProcess: ((command: string, args: readonly string[]) => {
        invocation = { command, args };
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.ok(invocation);
  // Pi's CLI is a plain script located through its package manifest, so it runs
  // under the current runtime rather than through a PATH shim or `cmd.exe`.
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0] ?? "", /pi-coding-agent[\\/].*\.js$/u);
  assert.equal(existsSync(invocation.args[0] ?? ""), true);
  for (const interpreter of ["cmd.exe", "cmd", "sh", "bash", "powershell"]) {
    assert.equal(basename(invocation.command).toLowerCase(), "node");
    assert.equal(invocation.args.includes(interpreter), false);
  }
});

test("does not respawn the current script just because Pi launched it", async () => {
  const previous = process.env.PI_CODING_AGENT;
  process.env.PI_CODING_AGENT = "true";
  try {
    const child = new FakeChild();
    let invocation: { args: readonly string[] } | undefined;
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        child.stdout.end(`${reportEvent(nodeOutput())}\n`);
        child.close(0);
      });
    });

    await runPiWorkerProcess(
      input(new AbortController().signal),
      { profiles: options.profiles, extensionPath: "/package/extensions/x.ts" },
      {
        spawnProcess: ((_command: string, args: readonly string[]) => {
          invocation = { args };
          return child as unknown as ChildProcessWithoutNullStreams;
        }) as never,
        terminateProcessTree: () => {},
      },
    );

    // The variable is inherited by anything Pi starts, so it must never be
    // read as proof that this process is Pi. The test runner is argv[1] here.
    assert.notEqual(invocation?.args[0], process.argv[1]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT;
    else process.env.PI_CODING_AGENT = previous;
  }
});

test("rejects configuration that is not a plain identifier or path", async () => {
  const profile = options.profiles.writer as PiWorkerProfile;
  const spawnProcess = (() => {
    throw new Error("must not spawn");
  }) as never;

  for (const hostile of [
    "&calc",
    "a|b",
    "%PATH%",
    "a b",
    "model^x",
    "-model",
    'a"b',
  ]) {
    for (const field of ["provider", "model"] as const) {
      await assert.rejects(
        runPiWorkerProcess(
          input(new AbortController().signal),
          {
            ...options,
            profiles: { writer: { ...profile, [field]: hostile } },
          },
          { spawnProcess },
        ),
        (error: unknown) =>
          error instanceof TaskExecutionFailure &&
          error.code === "invalid_profile",
        `${field}=${hostile}`,
      );
    }
  }

  // Ordinary provider and model forms Pi documents stay accepted.
  for (const model of [
    "claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-5:high",
    "gpt-4.1",
  ]) {
    assert.doesNotThrow(() =>
      createPiSubprocessExecutor({
        ...options,
        profiles: { writer: { ...profile, model } },
      }),
    );
  }

  // A path is not an identifier: spaces and `&` are legal in real paths, and
  // nothing routes them through a shell.
  assert.doesNotThrow(() =>
    createPiSubprocessExecutor({
      ...options,
      command: "C:\\Program Files\\A & B\\pi.exe",
    }),
  );
});

test("returns a retained artifact alongside the worker report", async () => {
  const child = new FakeChild();
  const output = nodeOutput("Investigated and reported");
  const artifact = `# Log\n\n${"entry\n".repeat(1024)}`;
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(output, artifact)}\n`);
      child.close(0);
    });
  });

  const result = await runPiWorkerProcess(
    input(new AbortController().signal),
    options,
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );

  assert.deepEqual(result, { output, artifact });
});

test("revalidates a child's artifact rather than trusting the details", async () => {
  // The child validated this already, but details cross a process boundary,
  // so the adapter treats the child's validation as evidence, not guarantee.
  for (const artifact of [
    "   ",
    42,
    "x".repeat(NODE_OUTPUT_LIMITS.maxArtifactBytes + 1),
  ]) {
    const child = new FakeChild();
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        child.stdout.end(`${reportEvent(nodeOutput(), artifact)}\n`);
        child.close(0);
      });
    });

    await assert.rejects(
      runPiWorkerProcess(input(new AbortController().signal), options, {
        spawnProcess: (() =>
          child as unknown as ChildProcessWithoutNullStreams) as never,
        terminateProcessTree: () => {},
      }),
      (error: unknown) =>
        error instanceof TaskExecutionFailure && error.code === "report_tool",
    );
  }
});

const REPORTED_USAGE = Object.freeze({
  input: 700,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_000,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
});

function assistantUsageEvent(usage: unknown): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage, content: [] },
  });
}

test("accounts for a worker whose events report usage", async () => {
  const output = nodeOutput("Completed with telemetry");

  assert.deepEqual(
    await runFakeWorker([
      assistantUsageEvent(REPORTED_USAGE),
      assistantUsageEvent(REPORTED_USAGE),
      reportEvent(output),
    ]),
    {
      output,
      usage: {
        ...REPORTED_USAGE,
        turns: 2,
        input: 1_400,
        output: 600,
        totalTokens: 2_000,
        cost: {
          input: 0.02,
          output: 0.04,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.06,
        },
      },
    },
  );
});

test("leaves a worker with no usage telemetry unaccounted, not free", async () => {
  const output = nodeOutput("Completed without telemetry");

  // A provider that reported nothing has not proved the work was free, so the
  // result carries no usage rather than a complete-looking set of zeros.
  assert.deepEqual(
    await runFakeWorker([assistantUsageEvent(undefined), reportEvent(output)]),
    {
      output,
    },
  );
});

test("treats unusable usage telemetry as unaccounted rather than cheap", async () => {
  const output = nodeOutput("Completed with bad telemetry");

  for (const usage of [
    { ...REPORTED_USAGE, input: -1 },
    { ...REPORTED_USAGE, output: "many" },
    { ...REPORTED_USAGE, totalTokens: Number.NaN },
    { ...REPORTED_USAGE, cost: "free" },
    { ...REPORTED_USAGE, cost: { ...REPORTED_USAGE.cost, total: -1 } },
  ]) {
    assert.deepEqual(
      await runFakeWorker([assistantUsageEvent(usage), reportEvent(output)]),
      { output },
    );
  }

  // An absent optional field is not a fault: a provider that bills no cache
  // write reports none, and the attempt is still accounted for.
  const { cacheWrite: _cacheWrite, ...withoutCacheWrite } = REPORTED_USAGE;
  const partial = await runFakeWorker([
    assistantUsageEvent(withoutCacheWrite),
    reportEvent(output),
  ]);
  assert.equal(partial.usage?.cacheWrite, 0);
  assert.equal(partial.usage?.totalTokens, 1_000);
});

test("reports the spend a failure accrued after the failure was latched", async () => {
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      // A delta arrives, then the stream breaks. The usage is only committed
      // when the child closes, after the failure code was latched.
      child.stdout.write(
        `${JSON.stringify({ type: "message_update", usage: REPORTED_USAGE })}\n`,
      );
      child.stdout.write("not json\n");
      child.stdout.end();
      child.close(0);
    });
  });

  await assert.rejects(
    runPiWorkerProcess(input(new AbortController().signal), options, {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionFailure);
      assert.equal(error.code, "protocol");
      assert.equal(error.usage?.totalTokens, 1_000);
      return true;
    },
  );
});
