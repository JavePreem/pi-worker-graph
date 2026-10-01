import assert from "node:assert/strict";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  parseTaskUsage,
  RUN_GRAPH_LIMITS,
  TASK_USAGE_LIMITS,
} from "../src/index.js";
import type {
  PiSubprocessExecutorOptions,
  PiWorkerProfile,
  PiWorkerProgress,
} from "../src/pi-subprocess.js";
import {
  REVIEW_LIMITS,
  runPiReviewedWorkerTask,
  runPiWorkerProcess,
} from "../src/pi-subprocess.js";
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

// --- review cycle -----------------------------------------------------------

const reviewedOptions: PiSubprocessExecutorOptions = {
  ...options,
  profiles: {
    ...options.profiles,
    reviewer: {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "low",
      tools: ["read"],
    },
  },
};

function reviewedPayload(
  maxRounds: number,
  criteria?: readonly string[],
): TaskExecutionInput["payload"] {
  return {
    assignment: "Implement the requested change",
    profile: "writer",
    acceptanceCriteria: ["Tests pass"],
    expectedPaths: ["src/example.ts"],
    review: {
      profile: "reviewer",
      maxRounds,
      ...(criteria === undefined ? {} : { criteria }),
    },
  };
}

type RoundUsage =
  | Record<string, unknown>
  | { readonly usage: Record<string, unknown>; readonly repeat: number };

function rejection(...blockers: readonly string[]): NodeOutput {
  return { ...nodeOutput("Review findings"), blockers: [...blockers] };
}

/**
 * Runs a review cycle against a scripted sequence of child reports: one entry
 * per round, in the order the cycle spawns them.
 */
async function runFakeCycle(
  reports: readonly NodeOutput[],
  payload: TaskExecutionInput["payload"],
  usagePerRound?: RoundUsage | readonly (RoundUsage | undefined)[],
  onProgress?: (progress: PiWorkerProgress) => void,
  controller: AbortController = new AbortController(),
  abortAfterRound?: number,
  runStateRoot?: string,
): Promise<{
  readonly result: Promise<TaskExecutionResult>;
  readonly prompts: string[];
  readonly argv: (readonly string[])[];
}> {
  const prompts: string[] = [];
  const argv: (readonly string[])[] = [];
  let round = 0;
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    argv.push(args);
    const index = round++;
    if (abortAfterRound !== undefined && index === abortAfterRound) {
      controller.abort();
    }
    const report = reports[index];
    if (report === undefined) {
      throw new Error(
        `the cycle spawned round ${index + 1}, beyond the ${reports.length} scripted`,
      );
    }
    const child = new FakeChild();
    let prompt = "";
    child.stdin.on("data", (chunk: Buffer) => {
      prompt += chunk.toString("utf8");
    });
    child.stdin.on("finish", () => {
      prompts.push(prompt);
      queueMicrotask(() => {
        const scripted = (
          Array.isArray(usagePerRound) ? usagePerRound[index] : usagePerRound
        ) as RoundUsage | undefined;
        const roundUsage =
          scripted === undefined
            ? undefined
            : "usage" in scripted
              ? scripted.usage
              : scripted;
        const repeat =
          scripted !== undefined && "repeat" in scripted
            ? (scripted.repeat as number)
            : 1;
        const lines = [
          ...(roundUsage === undefined
            ? []
            : Array.from({ length: repeat }, () =>
                JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    stopReason: "toolUse",
                    usage: roundUsage,
                  },
                }),
              )),
          reportEvent(report),
        ];
        child.stdout.end(lines.map((line) => `${line}\n`).join(""));
        child.close(0);
      });
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as never;
  return {
    result: runPiReviewedWorkerTask(
      runStateRoot === undefined
        ? input(controller.signal, payload)
        : { ...input(controller.signal, payload), runId: RUN_ID, runStateRoot },
      onProgress === undefined
        ? reviewedOptions
        : { ...reviewedOptions, onProgress },
      { spawnProcess, terminateProcessTree: () => {} },
    ),
    prompts,
    argv,
  };
}

const RUN_ID = "0f8b8a52-6a8e-4c43-9d2e-1d2a3b4c5d6e";

/** The session flags a child was spawned with, or `no-session`. */
function sessionOf(args: readonly string[]): string {
  if (args.includes("--no-session")) return "no-session";
  const dir = args[args.indexOf("--session-dir") + 1];
  const id = args[args.indexOf("--session-id") + 1];
  return `${dir} ${id}`;
}

test("a node's reviewer resumes one session across its rounds, under the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worker-graph-review-session-"));
  try {
    const { result, prompts, argv } = await runFakeCycle(
      [
        nodeOutput("First attempt"),
        rejection("Missing null check in parse()"),
        nodeOutput("Repaired attempt"),
        nodeOutput("Clean"),
      ],
      reviewedPayload(2),
      undefined,
      undefined,
      undefined,
      undefined,
      root,
    );
    await result;
    const sessions = argv.map(sessionOf);
    // Work and repair stay isolated; only the reviewer carries context.
    assert.equal(sessions[0], "no-session");
    assert.equal(sessions[2], "no-session");
    assert.match(
      sessions[1] as string,
      new RegExp(
        `^${join(root, "runs", RUN_ID, "sessions")} review-[0-9a-f]{32}$`,
        "u",
      ),
    );
    assert.equal(sessions[3], sessions[1], "the same session both rounds");
    assert.ok(existsSync(join(root, "runs", RUN_ID, "sessions")));
    assert.doesNotMatch(
      prompts[1] as string,
      /continues your own earlier review/u,
    );
    assert.match(prompts[3] as string, /continues your own earlier review/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reviewer with nowhere to keep a session reviews fresh each round", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worker-graph-review-session-"));
  // A file where the run directory would be, so the session cannot be made.
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "runs", RUN_ID), "not a directory");
  try {
    for (const stateRoot of [undefined, root]) {
      const { result, prompts, argv } = await runFakeCycle(
        [
          nodeOutput("First attempt"),
          rejection("Fix it"),
          nodeOutput("Repaired"),
          nodeOutput("Clean"),
        ],
        reviewedPayload(2),
        undefined,
        undefined,
        undefined,
        undefined,
        stateRoot,
      );
      await result;
      assert.deepEqual(argv.map(sessionOf), [
        "no-session",
        "no-session",
        "no-session",
        "no-session",
      ]);
      assert.doesNotMatch(
        prompts[3] as string,
        /continues your own earlier review/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task without a review policy runs exactly one worker", async () => {
  const { result, prompts } = await runFakeCycle([nodeOutput("Done")], {
    assignment: "Implement the requested change",
    profile: "writer",
  });
  const settled = await result;
  assert.equal(settled.output.summary, "Done");
  assert.equal(prompts.length, 1);
});

test("an accepted first review publishes the worker report, not the reviewer's", async () => {
  const { result, prompts } = await runFakeCycle(
    [nodeOutput("Implemented the change"), nodeOutput("Review findings")],
    reviewedPayload(2),
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Implemented the change");
  assert.equal(prompts.length, 2, "one work round and one review round");
  assert.match(
    prompts[1] as string,
    /reviewing another worker's completed work/u,
  );
  assert.match(prompts[1] as string, /Do not change any file/u);
});

test("a reviewer is told a sibling's edits are not the work under review", async () => {
  const { result, prompts } = await runFakeCycle(
    [nodeOutput("Implemented the change"), nodeOutput("Clean")],
    reviewedPayload(2),
  );
  await result;
  const review = prompts[1] as string;
  // Without this a reviewer reads the whole tree as one worker's doing and
  // rejects correct work for a file that worker never touched.
  assert.match(review, /Other workers are changing this same checkout/u);
  assert.match(review, /not evidence that this worker touched it/u);
  assert.match(review, /never ask for one to be reverted/u);
});

test("a worker is never told that a reviewer will check its work", async () => {
  const { result, prompts } = await runFakeCycle(
    [nodeOutput("Implemented the change"), nodeOutput("Clean")],
    reviewedPayload(2),
  );
  await result;
  assert.doesNotMatch(prompts[0] as string, /review/iu);
});

test("a rejected review sends its blockers to a repair round and re-reviews", async () => {
  const { result, prompts } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Missing null check in parse()", "No test for the empty case"),
      nodeOutput("Repaired attempt"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Repaired attempt");
  assert.equal(prompts.length, 4, "work, review, repair, review");
  const repair = prompts[2] as string;
  assert.match(repair, /A reviewer rejected the previous attempt/u);
  assert.match(repair, /Missing null check in parse\(\)/u);
  assert.match(repair, /No test for the empty case/u);
  assert.match(
    repair,
    /Implement the requested change/u,
    "keeps the original assignment",
  );
});

test("a node whose reviewer still rejects on the last round fails", async () => {
  const { result } = await runFakeCycle(
    [nodeOutput("First attempt"), rejection("Still wrong")],
    reviewedPayload(1),
  );
  // Failure reaches the runner as an output carrying blockers, which `run.ts`
  // records as a failed node while retaining the report.
  const settled = await result;
  assert.deepEqual(settled.output.blockers, ["Still wrong"]);
});

test("review criteria reach the reviewer and not the worker", async () => {
  const { result, prompts } = await runFakeCycle(
    [nodeOutput("Done"), nodeOutput("Clean")],
    reviewedPayload(1, ["Check error handling on every branch"]),
  );
  await result;
  assert.doesNotMatch(prompts[0] as string, /Check error handling/u);
  assert.match(prompts[1] as string, /Check error handling on every branch/u);
});

test("a reviewed node reports what every round spent, not just the last", async () => {
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Fix it"),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  );
  const settled = await result;
  assert.equal(
    settled.usage?.totalTokens,
    60,
    "four rounds of 15 tokens each are summed into the node's one attempt",
  );
  assert.equal(settled.usage?.input, 40);
});

test("a reviewed node reports the reviewer's share apart from the worker's", async () => {
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Fix it"),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    [
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
    ],
  );
  const settled = await result;
  // Work and repair run on the worker profile, the two reviews on the
  // reviewer's. One fused figure cannot say which of them spent what, which is
  // the whole reason the share is carried.
  assert.equal(settled.usage?.totalTokens, 220);
  assert.equal(settled.usage?.review?.totalTokens, 200);
  assert.equal(settled.usage?.review?.turns, 2, "two review rounds");
});

test("a node that ran no reviewer carries no review share at all", async () => {
  const { result } = await runFakeCycle(
    [nodeOutput("Done")],
    { assignment: "Implement the requested change", profile: "writer" },
    { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
  );
  const settled = await result;
  // Absent rather than zeroed: "spent nothing on review" is one shape, so a
  // reader never has to tell a zeroed share from a missing one.
  assert.equal(settled.usage?.totalTokens, 10);
  assert.equal(settled.usage?.review, undefined);
});

test("a cycle that fails mid-review still attributes what the reviewer spent", async () => {
  const { result } = await runFakeCycle(
    [nodeOutput("First attempt"), rejection("Fix it")],
    reviewedPayload(1),
    [
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
    ],
  );
  // Out of rounds with the work still refused, so the node fails on the
  // reviewer's report. The spend is real either way and stays attributed.
  const settled = await result;
  assert.equal(settled.output.blockers.length, 1);
  assert.equal(settled.usage?.totalTokens, 110);
  assert.equal(settled.usage?.review?.totalTokens, 100);
});

test("a thorough review is repaired rather than failed for its length", async () => {
  const { result, prompts } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection(...Array.from({ length: 40 }, (_, index) => `Defect ${index}`)),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Repaired");
  assert.match(prompts[2] as string, /Defect 39/u, "carries every finding");
});

test("findings too large for a repair payload fail the node with those findings", async () => {
  const finding = "x".repeat(8 * 1024);
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection(...Array.from({ length: 10 }, () => finding)),
    ],
    reviewedPayload(3),
  );
  const settled = await result;
  assert.equal(settled.output.blockers.length, 10);
});

test("an unknown reviewer profile is rejected before any worker starts", () => {
  const executor = createPiSubprocessExecutor(reviewedOptions);
  assert.throws(
    () =>
      executor.validateTasks?.([
        {
          id: "task",
          payload: {
            assignment: "Do the thing",
            profile: "writer",
            review: { profile: "missing-reviewer", maxRounds: 1 },
          },
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionFailure);
      assert.equal(error.code, "invalid_profile");
      return true;
    },
  );
});

test("a review policy outside its bounds is rejected", () => {
  const executor = createPiSubprocessExecutor(reviewedOptions);
  for (const review of [
    { profile: "reviewer", maxRounds: 0 },
    { profile: "reviewer", maxRounds: REVIEW_LIMITS.maxRounds + 1 },
    { profile: "reviewer" },
    { profile: "reviewer", maxRounds: 1, unknown: true },
  ]) {
    assert.throws(
      () =>
        executor.validateTasks?.([
          {
            id: "task",
            payload: { assignment: "Do it", profile: "writer", review },
          },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof TaskExecutionFailure);
        return true;
      },
      `expected ${JSON.stringify(review)} to be rejected`,
    );
  }
});

test("progress from a later round carries what the earlier rounds already spent", async () => {
  // A progress consumer keeps the latest event per task, so the last event a
  // reviewed node emits has to describe the whole node. Reporting each round's
  // own usage would tell the orchestrator a four-round node cost one round.
  const seen: PiWorkerProgress[] = [];
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Fix it"),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    (progress) => seen.push(progress),
  );
  const settled = await result;
  const last = seen.at(-1);
  assert.equal(
    last?.usage.totalTokens,
    settled.usage?.totalTokens,
    "the final progress event must agree with the node's reported usage",
  );
  assert.equal(last?.usage.totalTokens, 60);
  assert.ok(
    seen.every(
      (progress, index) =>
        index === 0 ||
        progress.usage.totalTokens >=
          (seen[index - 1] as PiWorkerProgress).usage.totalTokens,
    ),
    "usage across a cycle's progress must never go backwards",
  );
});

test("a cycle whose rounds report no telemetry stays unaccounted, not free", async () => {
  // Zero and unknown are different facts. A reviewed node whose children
  // reported nothing must not settle as having cost nothing.
  const { result } = await runFakeCycle(
    [nodeOutput("Done"), nodeOutput("Clean")],
    reviewedPayload(1),
  );
  const settled = await result;
  assert.equal(settled.usage, undefined);
});

test("one unaccounted round makes the whole cycle unaccounted", async () => {
  // A total is only as complete as its least-accounted round. Reporting the
  // rounds that did account, as if they were the whole node, would read as a
  // node that cost less than it did.
  const spent = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
  };
  for (const perRound of [
    [undefined, spent], // work silent, review accounted
    [spent, undefined], // work accounted, review silent
  ] as const) {
    const { result } = await runFakeCycle(
      [nodeOutput("Done"), nodeOutput("Clean")],
      reviewedPayload(1),
      perRound,
    );
    const settled = await result;
    assert.equal(
      settled.usage,
      undefined,
      `expected no usage when a round reported none: ${JSON.stringify(perRound)}`,
    );
  }
});

test("a cycle's summed usage saturates at the bounds one attempt may report", async () => {
  // Each child is bounded on its own, but a cycle runs several, so their sum
  // can pass a limit that bounds one. Every round here reports the maximum, so
  // an unsaturated sum would be several times the limit and `parseTaskUsage`
  // would reject the result — turning a node that succeeded into an invalid
  // one. The assertions are equalities with the maximum, not inequalities, so
  // the test cannot pass against an implementation that simply adds.
  const atLimit = {
    input: TASK_USAGE_LIMITS.maxTokens,
    output: TASK_USAGE_LIMITS.maxTokens,
    cacheRead: TASK_USAGE_LIMITS.maxTokens,
    cacheWrite: TASK_USAGE_LIMITS.maxTokens,
    totalTokens: TASK_USAGE_LIMITS.maxTokens,
    cost: {
      input: TASK_USAGE_LIMITS.maxCost,
      output: TASK_USAGE_LIMITS.maxCost,
      cacheRead: TASK_USAGE_LIMITS.maxCost,
      cacheWrite: TASK_USAGE_LIMITS.maxCost,
      total: TASK_USAGE_LIMITS.maxCost,
    },
  };
  const { result } = await runFakeCycle(
    [
      nodeOutput("First"),
      rejection("again"),
      nodeOutput("Second"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    Array.from({ length: 4 }, () => atLimit),
  );
  const settled = await result;
  assert.ok(settled.usage !== undefined);
  assert.equal(settled.usage.totalTokens, TASK_USAGE_LIMITS.maxTokens);
  assert.equal(settled.usage.input, TASK_USAGE_LIMITS.maxTokens);
  assert.equal(settled.usage.cost.total, TASK_USAGE_LIMITS.maxCost);
  assert.equal(settled.usage.cost.input, TASK_USAGE_LIMITS.maxCost);
  // The result has to survive the validation the runner puts it through.
  assert.doesNotThrow(() => parseTaskUsage(settled.usage));
});

test("turns saturate across rounds rather than overflowing the attempt bound", async () => {
  // Turns are the limit a real cycle reaches first: the adapter counts one per
  // assistant message, so rounds of a long-running node add up quickly.
  const perRound = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    repeat: TASK_USAGE_LIMITS.maxTurns,
  };
  const { result } = await runFakeCycle(
    [
      nodeOutput("First"),
      rejection("again"),
      nodeOutput("Second"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    Array.from({ length: 4 }, () => perRound),
  );
  const settled = await result;
  assert.equal(settled.usage?.turns, TASK_USAGE_LIMITS.maxTurns);
  assert.doesNotThrow(() => parseTaskUsage(settled.usage));
});

test("a rejection on the last round returns the reviewer's findings, not a bare code", async () => {
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection(
        "parse() still has no null check",
        "the empty case is untested",
      ),
    ],
    reviewedPayload(1),
  );
  const settled = await result;
  assert.deepEqual(settled.output.blockers, [
    "parse() still has no null check",
    "the empty case is untested",
  ]);
  // run.ts turns any output carrying blockers into a retained failure, so the
  // parent is handed the reason rather than an opaque diagnostics string.
  assert.ok(settled.output.blockers.length > 0);
});

test("a review payload too large to generate is rejected before any worker runs", () => {
  const executor = createPiSubprocessExecutor(reviewedOptions);
  // Sized into the window the finding describes: the submitted payload is
  // inside the limit, and only the generated review payload passes it.
  const near = "x".repeat(RUN_GRAPH_LIMITS.maxPayloadBytes - 400);
  assert.throws(
    () =>
      executor.validateTasks?.([
        {
          id: "task",
          payload: {
            assignment: near,
            profile: "writer",
            review: { profile: "reviewer", maxRounds: 2 },
          },
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof TaskExecutionFailure);
      assert.equal(error.code, "invalid_assignment");
      return true;
    },
  );
});

test("a reviewed node starts once and finishes once, whatever its rounds do", async () => {
  // A consumer counts finished events to show progress. Forwarding each
  // child's lifecycle would report the node complete when its first worker
  // reported, then un-complete it when review opened.
  const seen: PiWorkerProgress[] = [];
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Fix it"),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    undefined,
    (progress) => seen.push(progress),
  );
  await result;
  assert.equal(
    seen.filter((progress) => progress.phase === "started").length,
    1,
    "four child processes, one node start",
  );
  assert.equal(
    seen.filter((progress) => progress.phase === "finished").length,
    1,
    "four child processes, one node finish",
  );
  assert.equal(seen.at(-1)?.phase, "finished", "the node ends on its finish");
  assert.equal(seen.at(-1)?.status, "succeeded");
  assert.equal(seen.at(0)?.phase, "started", "and opens on its start");
});

test("a node rejected out of rounds finishes as failed", async () => {
  const seen: PiWorkerProgress[] = [];
  const { result } = await runFakeCycle(
    [nodeOutput("First attempt"), rejection("Still wrong")],
    reviewedPayload(1),
    undefined,
    (progress) => seen.push(progress),
  );
  await result;
  const finished = seen.filter((progress) => progress.phase === "finished");
  assert.equal(finished.length, 1);
  assert.equal(
    finished[0]?.status,
    "failed",
    "a reviewer answering successfully does not make the node succeed",
  );
});

test("a throwing progress observer cannot change a reviewed node's outcome", async () => {
  // Observability must never alter worker execution. An uncaught throw here
  // would fail a node its reviewer accepted.
  const { result } = await runFakeCycle(
    [nodeOutput("Implemented"), nodeOutput("Clean")],
    reviewedPayload(1),
    undefined,
    () => {
      throw new Error("observer exploded");
    },
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Implemented");
});

test("a throwing observer cannot mask why a reviewed node failed", async () => {
  const { result } = await runFakeCycle(
    [nodeOutput("Implemented")],
    reviewedPayload(1),
    undefined,
    () => {
      throw new Error("observer exploded");
    },
  );
  // The review round is unscripted, so the fake refuses to spawn it and the
  // cycle fails. The cause must survive the observer.
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof TaskExecutionFailure);
    assert.notEqual(error.message, "observer exploded");
    return true;
  });
});

test("a progress observer cannot corrupt the usage a reviewed node reports", async () => {
  const spentPerRound = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
  };
  const { result } = await runFakeCycle(
    [nodeOutput("Implemented"), nodeOutput("Clean")],
    reviewedPayload(1),
    spentPerRound,
    (progress) => {
      // A hostile or careless observer writing through the object it is handed.
      try {
        (progress.usage as { totalTokens: number }).totalTokens = 999_999;
        (progress.usage.cost as { total: number }).total = 999_999;
      } catch {
        // Frozen, which is the point.
      }
    },
  );
  const settled = await result;
  assert.equal(settled.usage?.totalTokens, 30, "two rounds of 15, unaltered");
  assert.notEqual(settled.usage?.cost.total, 999_999);
});

test("a reviewed node cancelled mid-cycle reports aborted, not failed", async () => {
  // The runner records a parent cancellation as aborted, and an unreviewed
  // worker reports it that way. A reviewed node saying "failed" here would
  // disagree with both the persisted outcome and its unreviewed sibling.
  const seen: PiWorkerProgress[] = [];
  const controller = new AbortController();
  const { result } = await runFakeCycle(
    [nodeOutput("Implemented"), nodeOutput("Clean")],
    reviewedPayload(2),
    undefined,
    (progress) => seen.push(progress),
    controller,
    1, // abort as the review round is about to spawn
  );
  await assert.rejects(result);
  const finished = seen.filter((progress) => progress.phase === "finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.status, "aborted");
});

test("a reviewed node that fails without cancellation still reports failed", async () => {
  const seen: PiWorkerProgress[] = [];
  const { result } = await runFakeCycle(
    [nodeOutput("Implemented")], // review round unscripted, so the fake refuses
    reviewedPayload(2),
    undefined,
    (progress) => seen.push(progress),
  );
  await assert.rejects(result);
  assert.equal(
    seen.filter((progress) => progress.phase === "finished")[0]?.status,
    "failed",
  );
});

// --- check cycle ------------------------------------------------------------

/**
 * Runs a node against a real checkout, where its check commands run for real,
 * while its workers are scripted: `onRound` stands in for what a round's
 * worker does to the checkout before it reports.
 */
async function runCheckedCycle(
  t: test.TestContext,
  reports: readonly NodeOutput[],
  payload: Record<string, unknown>,
  onRound: (round: number, checkout: string) => void = () => {},
  controller: AbortController = new AbortController(),
  onProgress?: (progress: PiWorkerProgress) => void,
  prepare: (checkout: string) => void = () => {},
): Promise<{
  readonly result: Promise<TaskExecutionResult>;
  readonly prompts: string[];
}> {
  const checkout = mkdtempSync(join(tmpdir(), "pi-worker-graph-check-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  prepare(checkout);
  const prompts: string[] = [];
  let round = 0;
  const spawnProcess = (() => {
    const index = round++;
    const report = reports[index];
    if (report === undefined) {
      throw new Error(
        `the cycle spawned round ${index + 1}, beyond the script`,
      );
    }
    const child = new FakeChild();
    let prompt = "";
    child.stdin.on("data", (chunk: Buffer) => {
      prompt += chunk.toString("utf8");
    });
    child.stdin.on("finish", () => {
      prompts.push(prompt);
      onRound(index, checkout);
      queueMicrotask(() => {
        child.stdout.end(`${reportEvent(report)}\n`);
        child.close(0);
      });
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as never;
  return {
    result: runPiReviewedWorkerTask(
      {
        ...input(controller.signal, payload as never),
        workingDirectory: checkout,
      },
      onProgress === undefined
        ? reviewedOptions
        : { ...reviewedOptions, onProgress },
      { spawnProcess, terminateProcessTree: () => {} },
    ),
    prompts,
  };
}

function checkedPayload(
  commands: readonly string[],
  maxRounds: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assignment: "Implement the requested change",
    profile: "writer",
    check: { commands, maxRounds, ...extra },
  };
}

const writeDone = (_round: number, checkout: string) =>
  writeFileSync(join(checkout, "done"), "");

test("a checked node whose check passes runs one worker and succeeds", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [nodeOutput("Implemented")],
    checkedPayload(["test -f done"], 2),
    (_round, checkout) => writeFileSync(join(checkout, "done"), ""),
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Implemented");
  assert.deepEqual(settled.output.blockers, []);
  assert.equal(prompts.length, 1);
});

test("a worker is told the check commands it has to pass", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [nodeOutput("Implemented")],
    checkedPayload(["test -f done"], 1),
    writeDone,
  );
  await result;
  assert.match(prompts[0] as string, /"checkCommands":\["test -f done"\]/u);
  assert.match(prompts[0] as string, /succeeds only if each one exits 0/u);
  assert.doesNotMatch(prompts[0] as string, /review/iu);
});

test("a failing check sends its output to a repair round and checks again", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [nodeOutput("First attempt"), nodeOutput("Repaired")],
    checkedPayload(["echo 'expected 4, got 5'; test -f done"], 2),
    (round, checkout) => {
      if (round === 1) writeFileSync(join(checkout, "done"), "");
    },
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Repaired");
  assert.deepEqual(settled.output.blockers, []);
  assert.equal(prompts.length, 2, "work, then one repair");
  const repair = prompts[1] as string;
  assert.match(repair, /check commands after the previous attempt/u);
  assert.match(repair, /CHECK FAILURES/u);
  assert.match(repair, /expected 4, got 5/u);
  assert.match(repair, /Implement the requested change/u);
});

test("a check still failing on its last round fails the node with its output", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [nodeOutput("First attempt"), nodeOutput("Second attempt")],
    checkedPayload(["echo 'spec: 3 failing'; exit 3", "test -f done"], 2),
    writeDone,
  );
  const settled = await result;
  assert.equal(prompts.length, 2);
  assert.equal(settled.output.blockers.length, 1, "only the failing command");
  assert.match(settled.output.blockers[0] as string, /Exit code: 3/u);
  assert.match(settled.output.blockers[0] as string, /spec: 3 failing/u);
});

test("a check runs before the review, and the review sees passing work", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [nodeOutput("First attempt"), nodeOutput("Repaired"), nodeOutput("Clean")],
    {
      ...checkedPayload(["test -f done"], 2),
      review: { profile: "reviewer", maxRounds: 1 },
    },
    (round, checkout) => {
      if (round === 1) writeFileSync(join(checkout, "done"), "");
    },
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Repaired");
  assert.equal(prompts.length, 3, "work, check repair, review");
  assert.match(prompts[1] as string, /CHECK FAILURES/u);
  assert.match(
    prompts[2] as string,
    /reviewing another worker's completed work/u,
  );
});

test("a node cancelled during its check reports aborted", async (t) => {
  const controller = new AbortController();
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Implemented")],
    checkedPayload(["test -f done && sleep 30"], 1),
    (round, checkout) => {
      writeDone(round, checkout);
      setTimeout(() => controller.abort(), 100);
    },
    controller,
  );
  const started = Date.now();
  await assert.rejects(result, TaskExecutionFailure);
  assert.ok(Date.now() - started < 10_000, "the command was stopped");
});

test("a check policy outside its bounds is rejected", () => {
  const executor = createPiSubprocessExecutor(reviewedOptions);
  for (const check of [
    { commands: ["true"], maxRounds: 0 },
    { commands: ["true"], maxRounds: 5 },
    { commands: [], maxRounds: 1 },
    { commands: [" "], maxRounds: 1 },
    { commands: ["x".repeat(1025)], maxRounds: 1 },
    { commands: Array.from({ length: 9 }, () => "true"), maxRounds: 1 },
    { commands: ["true"], maxRounds: 1, unknown: true },
    { commands: ["true"], maxRounds: 1, before: "maybe" },
    { commands: ["true"], maxRounds: 1, frozen: [] },
    { commands: ["true"], maxRounds: 1, frozen: ["../outside"] },
    { commands: ["true"], maxRounds: 1, frozen: ["/etc/passwd"] },
  ]) {
    assert.throws(
      () =>
        executor.validateTasks?.([
          {
            id: "task",
            payload: { assignment: "Do it", profile: "writer", check },
          },
        ]),
      TaskExecutionFailure,
      `expected ${JSON.stringify(check)} to be rejected`,
    );
  }
});

test("a check that already passes fails the node before any worker runs", async (t) => {
  const { result, prompts } = await runCheckedCycle(
    t,
    [],
    checkedPayload(["true", "test -f done"], 2),
  );
  const settled = await result;
  assert.equal(prompts.length, 0, "no worker was spent");
  assert.equal(settled.output.blockers.length, 1, "only the vacuous command");
  assert.match(
    settled.output.blockers[0] as string,
    /passed before any work, so it cannot judge the task: true/u,
  );
});

test("a check declared to pass before must pass before and after the work", async (t) => {
  const refused = await runCheckedCycle(
    t,
    [],
    checkedPayload(["test -f done"], 1, { before: "pass" }),
  );
  assert.match(
    (await refused.result).output.blockers[0] as string,
    /failed before any work/u,
  );

  const kept = await runCheckedCycle(
    t,
    [nodeOutput("Refactored")],
    checkedPayload(["test -f done"], 1, { before: "pass" }),
    undefined,
    undefined,
    undefined,
    (checkout) => writeFileSync(join(checkout, "done"), ""),
  );
  const settled = await kept.result;
  assert.equal(settled.output.summary, "Refactored");
  assert.deepEqual(settled.output.blockers, []);
});

test("a worker that edits a frozen path fails its node even when the check passes", async (t) => {
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Made the test pass")],
    checkedPayload(["grep -q pass spec/check.txt"], 2, { frozen: ["spec"] }),
    (_round, checkout) =>
      writeFileSync(join(checkout, "spec", "check.txt"), "pass"),
    undefined,
    undefined,
    (checkout) => {
      mkdirSync(join(checkout, "spec"));
      writeFileSync(join(checkout, "spec", "check.txt"), "fail");
    },
  );
  const settled = await result;
  assert.equal(settled.output.blockers.length, 1);
  assert.match(
    settled.output.blockers[0] as string,
    /A frozen path changed while this task ran: spec/u,
  );
});

test("what the check writes into a frozen path is not a worker's change", async (t) => {
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Done")],
    checkedPayload(["touch spec/cache; test -f done"], 1, { frozen: ["spec"] }),
    writeDone,
    undefined,
    undefined,
    (checkout) => mkdirSync(join(checkout, "spec")),
  );
  const settled = await result;
  assert.equal(settled.output.summary, "Done");
  assert.deepEqual(settled.output.blockers, []);
});

test("bytecode a worker's own test runs leave in a frozen path is not an edit", async (t) => {
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Done")],
    checkedPayload(["test -f done"], 1, { frozen: ["spec"] }),
    (round, checkout) => {
      writeDone(round, checkout);
      mkdirSync(join(checkout, "spec", "__pycache__"));
      writeFileSync(join(checkout, "spec", "__pycache__", "t.pyc"), "");
    },
    undefined,
    undefined,
    (checkout) => mkdirSync(join(checkout, "spec")),
  );
  assert.deepEqual((await result).output.blockers, []);
});

test("a file a worker adds to a frozen path is an edit", async (t) => {
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Done")],
    checkedPayload(["test -f done"], 1, { frozen: ["spec"] }),
    (round, checkout) => {
      writeDone(round, checkout);
      writeFileSync(join(checkout, "spec", "conftest.py"), "");
    },
    undefined,
    undefined,
    (checkout) => mkdirSync(join(checkout, "spec")),
  );
  assert.match(
    (await result).output.blockers[0] as string,
    /A frozen path changed while this task ran: spec/u,
  );
});

test("a check keeps Python's bytecode out of the checkout", async (t) => {
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Done")],
    checkedPayload(
      [
        'case "$PYTHONPYCACHEPREFIX" in "" | "$PWD"*) exit 2 ;; esac; test -f done',
      ],
      1,
    ),
    writeDone,
  );
  assert.deepEqual((await result).output.blockers, []);
});

test("a check that cannot isolate Python's bytecode fails instead of running", async (t) => {
  const previous = process.env.TMPDIR;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("Done")],
    checkedPayload(["test -f done"], 1),
    (round, checkout) => {
      writeDone(round, checkout);
      // Only the check after the work loses its temporary directory.
      process.env.TMPDIR = join(checkout, "missing", "tmp");
    },
  );
  assert.match(
    (await result).output.blockers[0] as string,
    /No directory for Python's bytecode cache could be created/u,
  );
});

test("a checked node traces how its check went on its terminal event", async (t) => {
  const seen: PiWorkerProgress[] = [];
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("First attempt"), nodeOutput("Repaired")],
    checkedPayload(["test -f done", "test -f other"], 2),
    (round, checkout) => {
      writeDone(round, checkout);
      if (round === 1) writeFileSync(join(checkout, "other"), "");
    },
    undefined,
    (progress) => seen.push(progress),
  );
  await result;
  const finished = seen.filter((progress) => progress.phase === "finished");
  assert.deepEqual(
    finished.map((progress) => progress.check),
    [{ failingBefore: 2, commands: 2, runs: 2, outcome: "passed" }],
  );
});

test("a reviewed node's terminal event traces every round in order", async () => {
  const seen: PiWorkerProgress[] = [];
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    },
  };
  const { result } = await runFakeCycle(
    [
      nodeOutput("First attempt"),
      rejection("Missing null check", "No empty-case test"),
      nodeOutput("Repaired"),
      nodeOutput("Clean"),
    ],
    reviewedPayload(2),
    usage,
    (progress) => seen.push(progress),
  );
  await result;
  const terminal = seen.filter((progress) => progress.phase === "finished");
  assert.equal(terminal.length, 1);
  const rounds = terminal[0]?.rounds ?? [];
  // Convergence is readable per round: two findings, then none.
  assert.deepEqual(
    rounds.map((round) => [round.kind, round.blockers]),
    [
      ["work", 0],
      ["review", 2],
      ["repair", 0],
      ["review", 0],
    ],
  );
  for (const round of rounds) {
    assert.equal(round.usage?.cost.total, 0.03);
    assert.ok(round.durationMs >= 0);
  }
  assert.ok((terminal[0]?.durationMs ?? -1) >= 0);
  // A round's own lifecycle never reads as the node's.
  assert.equal(
    seen.filter((progress) => progress.durationMs !== undefined).length,
    1,
  );
});

test("a checked node traces its checks beside its rounds, spending nothing on them", async (t) => {
  const seen: PiWorkerProgress[] = [];
  const { result } = await runCheckedCycle(
    t,
    [nodeOutput("First attempt"), nodeOutput("Repaired")],
    checkedPayload(["test -f done"], 2),
    (round, checkout) => {
      if (round === 1) writeFileSync(join(checkout, "done"), "");
    },
    undefined,
    (progress) => seen.push(progress),
  );
  await result;
  const rounds =
    seen.find((progress) => progress.phase === "finished")?.rounds ?? [];
  assert.deepEqual(
    rounds.map((round) => [round.kind, round.blockers]),
    [
      ["check_before", 0],
      ["work", 0],
      ["check", 1],
      ["repair", 0],
      ["check", 0],
    ],
  );
  for (const round of rounds.filter((r) => r.kind.startsWith("check")))
    assert.equal(round.usage, undefined);
});

test("an unchecked worker's terminal event carries its wall-clock", async () => {
  const seen: PiWorkerProgress[] = [];
  const child = new FakeChild();
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.end(`${reportEvent(nodeOutput("Done"))}\n`);
      child.close(0);
    });
  });
  await runPiWorkerProcess(
    input(new AbortController().signal),
    { ...options, onProgress: (progress) => seen.push(progress) },
    {
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as never,
      terminateProcessTree: () => {},
    },
  );
  const terminal = seen.find((progress) => progress.phase === "finished");
  assert.ok((terminal?.durationMs ?? -1) >= 0);
  assert.equal(terminal?.rounds, undefined);
});
