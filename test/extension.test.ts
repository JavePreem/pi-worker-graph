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

test("registers a terminating final-report tool only in worker mode", async (t) => {
  const previousRole = process.env.PI_WORKER_GRAPH_ROLE;
  t.after(() => restoreWorkerRole(previousRole));

  delete process.env.PI_WORKER_GRAPH_ROLE;
  let parentRegistrations = 0;
  registerWorkerGraph({
    registerTool() {
      parentRegistrations += 1;
    },
  } as never);
  assert.equal(parentRegistrations, 0);

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
