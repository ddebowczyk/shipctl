import type { ModuleJsonValue } from "@shipctl/module-api";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function hasIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function hasWorkspaceName(value: unknown): value is string {
  return hasIdentity(value)
    && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
}

export function hasSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function hasSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys);
  return Object.keys(value).every((key) => accepted.has(key));
}

export function jsonSafe(
  value: unknown,
  ancestors: Set<object> = new Set<object>(),
): value is ModuleJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!isPlainRecord(value) && !Array.isArray(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonSafe(item, ancestors))
    : Object.values(value).every((item) => jsonSafe(item, ancestors));
  ancestors.delete(value);
  return valid;
}

export function cloneAndFreeze<Value>(value: Value): Value {
  const copy = structuredClone(value);
  return deepFreeze(copy);
}

export function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sortedUnique(values: readonly string[]): readonly string[] | null {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  return sorted.every((value, index) => index === 0 || value !== sorted[index - 1])
    ? Object.freeze(sorted)
    : null;
}
