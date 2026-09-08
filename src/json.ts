export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const MAX_JSON_DEPTH = 100;

function isJsonValueAtDepth(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MAX_JSON_DEPTH) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    valid = keys.length === value.length + 1 && keys.includes("length");
    for (let index = 0; valid && index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      valid =
        descriptor?.enumerable === true &&
        "value" in descriptor &&
        isJsonValueAtDepth(descriptor.value, ancestors, depth + 1);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = prototype === Object.prototype || prototype === null;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !valid ||
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonValueAtDepth(descriptor.value, ancestors, depth + 1)
      ) {
        valid = false;
        break;
      }
    }
  }
  ancestors.delete(value);
  return valid;
}

/** Returns false for cyclic, excessively deep, or hostile values. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return isJsonValueAtDepth(value, new Set(), 0);
  } catch {
    return false;
  }
}

export function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}
