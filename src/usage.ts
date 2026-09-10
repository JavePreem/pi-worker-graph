/**
 * Transport-independent token and cost accounting for one task attempt.
 *
 * The graph runner, the run store, and the Pi adapter all handle these
 * numbers, so the shape and its validation live below all three. Values are
 * reported by an executor, which is why every field is bounded and validated
 * rather than trusted: usage reaches persisted run state.
 */
export interface TaskUsage {
  readonly turns: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export const TASK_USAGE_LIMITS = Object.freeze({
  maxTurns: 256,
  maxTokens: 1_000_000_000_000,
  maxCost: 1_000_000_000,
});

const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
] as const;
const COST_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "total",
] as const;
const USAGE_FIELDS = new Set<string>(["turns", ...TOKEN_FIELDS, "cost"]);
const COST_FIELD_NAMES = new Set<string>(COST_FIELDS);

function fail(): never {
  throw new TypeError("Task usage is invalid or out of range");
}

/**
 * Reads a data field without invoking an accessor, so a reported usage object
 * cannot run code or hide a value behind a getter.
 */
function dataField(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) fail();
  return descriptor.value;
}

function plainFields(value: unknown, allowed: ReadonlySet<string>): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail();
  }
  return value;
}

function bounded(value: unknown, maximum: number, integer: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    fail();
  }
  return value as number;
}

/**
 * Validates reported usage into an immutable snapshot. Absence is normal: an
 * executor that does not account for its own spend reports nothing rather
 * than reporting zeros, which would read as work that cost nothing.
 */
export function parseTaskUsage(value: unknown): TaskUsage | undefined {
  if (value === undefined) return undefined;
  const usage = plainFields(value, USAGE_FIELDS);
  const cost = plainFields(dataField(usage, "cost"), COST_FIELD_NAMES);
  const tokens = TOKEN_FIELDS.map((field) =>
    bounded(dataField(usage, field), TASK_USAGE_LIMITS.maxTokens, true),
  );
  const costs = COST_FIELDS.map((field) =>
    bounded(dataField(cost, field), TASK_USAGE_LIMITS.maxCost, false),
  );
  return Object.freeze({
    turns: bounded(dataField(usage, "turns"), TASK_USAGE_LIMITS.maxTurns, true),
    input: tokens[0] as number,
    output: tokens[1] as number,
    cacheRead: tokens[2] as number,
    cacheWrite: tokens[3] as number,
    totalTokens: tokens[4] as number,
    cost: Object.freeze({
      input: costs[0] as number,
      output: costs[1] as number,
      cacheRead: costs[2] as number,
      cacheWrite: costs[3] as number,
      total: costs[4] as number,
    }),
  });
}
