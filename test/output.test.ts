import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_OUTPUT_LIMITS,
  NODE_OUTPUT_SCHEMA_VERSION,
  NodeOutputValidationError,
  parseNodeOutput,
} from "../src/index.js";
import { nodeOutput } from "./fixtures.js";

function rejectsReport(
  value: unknown,
  code: NodeOutputValidationError["code"],
  path?: string,
): void {
  assert.throws(
    () => parseNodeOutput(value),
    (error: unknown) => {
      assert.ok(error instanceof NodeOutputValidationError);
      assert.equal(error.code, code);
      if (path !== undefined) assert.equal(error.path, path);
      return true;
    },
  );
}

test("parses a complete versioned report into an immutable snapshot", () => {
  const input = {
    schemaVersion: NODE_OUTPUT_SCHEMA_VERSION,
    summary: "Implemented the public report contract",
    changedFiles: [
      { path: "src/output.ts", description: "Added report validation" },
    ],
    interfaces: ["NodeOutput is the worker report contract"],
    decisions: ["Reject malformed reports instead of repairing them"],
    validation: [{ command: "npm test", result: "Passed" }],
    blockers: [],
  };

  const output = parseNodeOutput(input);
  input.summary = "mutated";
  const inputChangedFile = input.changedFiles[0];
  assert.ok(inputChangedFile);
  inputChangedFile.description = "mutated";

  assert.equal(output.summary, "Implemented the public report contract");
  assert.equal(output.changedFiles[0]?.description, "Added report validation");
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.changedFiles));
  assert.ok(Object.isFrozen(output.changedFiles[0]));
  assert.ok(Object.isFrozen(output.validation));
  assert.ok(Object.isFrozen(output.validation[0]));
});

test("requires the exact versioned report shape", () => {
  rejectsReport(null, "invalid_field", "$");
  rejectsReport(
    { ...nodeOutput(), schemaVersion: 2 },
    "invalid_schema_version",
    "$.schemaVersion",
  );

  const { summary: _summary, ...missingSummary } = nodeOutput();
  rejectsReport(missingSummary, "missing_field", "$.summary");
  rejectsReport(
    { ...nodeOutput(), transcript: "undeclared context" },
    "unknown_field",
    "$.transcript",
  );
  rejectsReport(
    { ...nodeOutput(), interfaces: "not an array" },
    "invalid_field",
    "$.interfaces",
  );
  rejectsReport(
    { ...nodeOutput(), decisions: [" "] },
    "invalid_field",
    "$.decisions[0]",
  );
  class CustomArray extends Array<string> {}
  rejectsReport(
    { ...nodeOutput(), interfaces: new CustomArray("interface") },
    "invalid_value",
    "$.interfaces",
  );
  rejectsReport(
    {
      ...nodeOutput(),
      changedFiles: [
        { path: "src/output.ts", description: "Changed", extra: true },
      ],
    },
    "unknown_field",
    "$.changedFiles[0].extra",
  );

  for (const path of [
    "../escape.ts",
    "/absolute.ts",
    "C:/absolute.ts",
    "src\\windows.ts",
    "src//empty.ts",
    "src/./same.ts",
  ]) {
    rejectsReport(
      {
        ...nodeOutput(),
        changedFiles: [{ path, description: "Changed" }],
      },
      "invalid_field",
      "$.changedFiles[0].path",
    );
  }
});

test("enforces item, text, path, and aggregate byte limits", () => {
  const boundary = parseNodeOutput({
    ...nodeOutput("x".repeat(NODE_OUTPUT_LIMITS.maxTextBytes)),
    changedFiles: [
      {
        path: "x".repeat(NODE_OUTPUT_LIMITS.maxPathBytes),
        description: "Changed",
      },
    ],
    blockers: Array.from(
      { length: NODE_OUTPUT_LIMITS.maxItemsPerSection },
      () => "blocked",
    ),
  });
  assert.equal(
    Buffer.byteLength(boundary.summary),
    NODE_OUTPUT_LIMITS.maxTextBytes,
  );
  assert.equal(boundary.blockers.length, NODE_OUTPUT_LIMITS.maxItemsPerSection);

  rejectsReport(
    {
      ...nodeOutput(),
      blockers: Array.from(
        { length: NODE_OUTPUT_LIMITS.maxItemsPerSection + 1 },
        () => "blocked",
      ),
    },
    "item_limit",
    "$.blockers",
  );
  rejectsReport(
    {
      ...nodeOutput(),
      summary: "x".repeat(NODE_OUTPUT_LIMITS.maxTextBytes + 1),
    },
    "text_limit",
    "$.summary",
  );
  rejectsReport(
    {
      ...nodeOutput(),
      changedFiles: [
        {
          path: "x".repeat(NODE_OUTPUT_LIMITS.maxPathBytes + 1),
          description: "Changed",
        },
      ],
    },
    "text_limit",
    "$.changedFiles[0].path",
  );
  rejectsReport(
    {
      ...nodeOutput(),
      decisions: Array.from({ length: 9 }, () =>
        "x".repeat(NODE_OUTPUT_LIMITS.maxTextBytes),
      ),
    },
    "output_limit",
    "$",
  );
});

test("measures text limits in UTF-8 bytes", () => {
  rejectsReport(
    {
      ...nodeOutput(),
      summary: "雪".repeat(Math.floor(NODE_OUTPUT_LIMITS.maxTextBytes / 3) + 1),
    },
    "text_limit",
    "$.summary",
  );
});

test("rejects cyclic and hostile values without exposing thrown details", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(
    () => parseNodeOutput(cyclic),
    (error: unknown) => error instanceof NodeOutputValidationError,
  );

  const hostile = Object.defineProperty({}, "summary", {
    enumerable: true,
    get() {
      throw new Error("secret getter detail");
    },
  });
  assert.throws(
    () => parseNodeOutput(hostile),
    (error: unknown) => {
      assert.ok(error instanceof NodeOutputValidationError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.message.includes("secret getter detail"), false);
      return true;
    },
  );
});
