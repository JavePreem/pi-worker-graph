export const NODE_OUTPUT_SCHEMA_VERSION = 1;

export const NODE_OUTPUT_LIMITS = Object.freeze({
  maxBytes: 96 * 1024,
  maxItemsPerSection: 128,
  maxTextBytes: 16 * 1024,
  maxPathBytes: 4 * 1024,
  maxDiagnosticsBytes: 16 * 1024,
});

export interface NodeOutput {
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly changedFiles: readonly {
    readonly path: string;
    readonly description: string;
  }[];
  readonly interfaces: readonly string[];
  readonly decisions: readonly string[];
  readonly validation: readonly {
    readonly command: string;
    readonly result: string;
  }[];
  /** A non-empty blocker list makes the node fail while retaining this report. */
  readonly blockers: readonly string[];
}

export type NodeOutputValidationErrorCode =
  | "invalid_value"
  | "output_limit"
  | "missing_field"
  | "unknown_field"
  | "invalid_schema_version"
  | "invalid_field"
  | "item_limit"
  | "text_limit";

export class NodeOutputValidationError extends Error {
  readonly code: NodeOutputValidationErrorCode;
  readonly path: string;

  constructor(
    code: NodeOutputValidationErrorCode,
    path: string,
    message: string,
  ) {
    super(`Invalid node output at ${path}: ${message}`);
    this.name = "NodeOutputValidationError";
    this.code = code;
    this.path = path;
  }
}

const OUTPUT_FIELDS = new Set([
  "schemaVersion",
  "summary",
  "changedFiles",
  "interfaces",
  "decisions",
  "validation",
  "blockers",
]);
const CHANGED_FILE_FIELDS = new Set(["path", "description"]);
const VALIDATION_FIELDS = new Set(["command", "result"]);
const SIMPLE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;

interface ParseBudget {
  serializedTextBytes: number;
}

function fail(
  code: NodeOutputValidationErrorCode,
  path: string,
  message: string,
): never {
  throw new NodeOutputValidationError(code, path, message);
}

function fieldPath(path: string, field: string): string {
  return field.length <= 64 && SIMPLE_FIELD.test(field)
    ? `${path}.${field}`
    : path;
}

function dataFields(
  value: unknown,
  path: string,
  maxFields: number,
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("invalid_value", path, "expected a plain object");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length > maxFields) {
    fail("unknown_field", path, "object contains too many fields");
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      fail("invalid_value", path, "symbol fields are not allowed");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail("invalid_value", fieldPath(path, key), "expected a data field");
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactFields(
  value: unknown,
  expected: ReadonlySet<string>,
  path: string,
): ReadonlyMap<string, unknown> {
  const fields = dataFields(value, path, expected.size + 1);
  for (const field of expected) {
    if (!fields.has(field)) {
      fail("missing_field", `${path}.${field}`, "field is required");
    }
  }
  for (const field of [...fields.keys()].sort()) {
    if (!expected.has(field)) {
      fail("unknown_field", fieldPath(path, field), "field is not allowed");
    }
  }
  return fields;
}

function arrayItems(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail("invalid_field", path, "expected an array");
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return fail("invalid_value", path, "expected a plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return fail("invalid_value", path, "array has an invalid length");
  }
  const length = lengthDescriptor.value as number;
  if (length > NODE_OUTPUT_LIMITS.maxItemsPerSection) {
    fail(
      "item_limit",
      path,
      `section exceeds ${NODE_OUTPUT_LIMITS.maxItemsPerSection} items`,
    );
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    fail("invalid_value", path, "expected a dense array without extra fields");
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail("invalid_value", `${path}[${index}]`, "expected a data item");
    }
    items.push(descriptor.value);
  }
  return items;
}

function text(
  value: unknown,
  path: string,
  maxBytes: number,
  budget: ParseBudget,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("invalid_field", path, "expected a non-empty string");
  }
  if (Buffer.byteLength(value) > maxBytes) {
    fail("text_limit", path, `text exceeds ${maxBytes} bytes`);
  }
  budget.serializedTextBytes += Buffer.byteLength(JSON.stringify(value));
  if (budget.serializedTextBytes > NODE_OUTPUT_LIMITS.maxBytes) {
    fail(
      "output_limit",
      "$",
      `serialized report exceeds ${NODE_OUTPUT_LIMITS.maxBytes} bytes`,
    );
  }
  return value;
}

function reportPath(value: unknown, path: string, budget: ParseBudget): string {
  const parsed = text(value, path, NODE_OUTPUT_LIMITS.maxPathBytes, budget);
  const segments = parsed.split("/");
  if (
    parsed.startsWith("/") ||
    parsed.includes("\\") ||
    WINDOWS_DRIVE_PATH.test(parsed) ||
    [...parsed].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    }) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    fail(
      "invalid_field",
      path,
      "expected a normalized repository-relative path",
    );
  }
  return parsed;
}

function textSection(
  value: unknown,
  path: string,
  budget: ParseBudget,
): readonly string[] {
  return Object.freeze(
    arrayItems(value, path).map((item, index) =>
      text(item, `${path}[${index}]`, NODE_OUTPUT_LIMITS.maxTextBytes, budget),
    ),
  );
}

function parseReport(value: unknown): NodeOutput {
  const budget: ParseBudget = { serializedTextBytes: 0 };
  const candidate = exactFields(value, OUTPUT_FIELDS, "$");
  if (candidate.get("schemaVersion") !== NODE_OUTPUT_SCHEMA_VERSION) {
    fail(
      "invalid_schema_version",
      "$.schemaVersion",
      `expected schema version ${NODE_OUTPUT_SCHEMA_VERSION}`,
    );
  }

  const changedFiles = Object.freeze(
    arrayItems(candidate.get("changedFiles"), "$.changedFiles").map(
      (item, index) => {
        const path = `$.changedFiles[${index}]`;
        const changedFile = exactFields(item, CHANGED_FILE_FIELDS, path);
        return Object.freeze({
          path: reportPath(changedFile.get("path"), `${path}.path`, budget),
          description: text(
            changedFile.get("description"),
            `${path}.description`,
            NODE_OUTPUT_LIMITS.maxTextBytes,
            budget,
          ),
        });
      },
    ),
  );
  const validation = Object.freeze(
    arrayItems(candidate.get("validation"), "$.validation").map(
      (item, index) => {
        const path = `$.validation[${index}]`;
        const result = exactFields(item, VALIDATION_FIELDS, path);
        return Object.freeze({
          command: text(
            result.get("command"),
            `${path}.command`,
            NODE_OUTPUT_LIMITS.maxTextBytes,
            budget,
          ),
          result: text(
            result.get("result"),
            `${path}.result`,
            NODE_OUTPUT_LIMITS.maxTextBytes,
            budget,
          ),
        });
      },
    ),
  );

  const output = Object.freeze({
    schemaVersion: NODE_OUTPUT_SCHEMA_VERSION,
    summary: text(
      candidate.get("summary"),
      "$.summary",
      NODE_OUTPUT_LIMITS.maxTextBytes,
      budget,
    ),
    changedFiles,
    interfaces: textSection(
      candidate.get("interfaces"),
      "$.interfaces",
      budget,
    ),
    decisions: textSection(candidate.get("decisions"), "$.decisions", budget),
    validation,
    blockers: textSection(candidate.get("blockers"), "$.blockers", budget),
  });
  if (Buffer.byteLength(JSON.stringify(output)) > NODE_OUTPUT_LIMITS.maxBytes) {
    fail(
      "output_limit",
      "$",
      `serialized report exceeds ${NODE_OUTPUT_LIMITS.maxBytes} bytes`,
    );
  }
  return output;
}

/** Validates an untrusted worker report and returns an immutable snapshot. */
export function parseNodeOutput(value: unknown): NodeOutput {
  try {
    return parseReport(value);
  } catch (error) {
    if (error instanceof NodeOutputValidationError) throw error;
    return fail("invalid_value", "$", "value cannot be inspected safely");
  }
}

/** Internal shared validation for persisted and executor diagnostics. */
export function parseNodeDiagnostics(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return fail("invalid_field", "$.diagnostics", "expected a string");
  }
  if (
    Buffer.byteLength(value) > NODE_OUTPUT_LIMITS.maxDiagnosticsBytes ||
    Buffer.byteLength(JSON.stringify(value)) >
      NODE_OUTPUT_LIMITS.maxDiagnosticsBytes
  ) {
    fail(
      "text_limit",
      "$.diagnostics",
      `diagnostics exceed ${NODE_OUTPUT_LIMITS.maxDiagnosticsBytes} bytes`,
    );
  }
  return value;
}
