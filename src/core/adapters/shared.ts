// Small parsing helpers shared by adapters (ADR 0008).

import type { Diagnostic, SourceRef } from "../model/index.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type Diagnose = (severity: Diagnostic["severity"], code: string, message: string, source: SourceRef) => void;

/** Strict ISO 8601 with time zone → epoch milliseconds, or null. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
