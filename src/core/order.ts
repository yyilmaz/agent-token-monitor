// Locale-independent ordering helpers (R-10). Never use localeCompare: its result depends on the host locale.

import type { SourceRef } from "./model/index.js";

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSources(a: SourceRef, b: SourceRef): number {
  return compareStrings(a.logRoot, b.logRoot) || compareStrings(a.file, b.file) || a.line - b.line;
}

/** Canonical order of calls and events: (timestamp, first source) (ADR 0008 rule 7). */
export function compareByTimeThenSource(
  a: { readonly timestamp: number; readonly sources: readonly SourceRef[] },
  b: { readonly timestamp: number; readonly sources: readonly SourceRef[] },
): number {
  return a.timestamp - b.timestamp || compareFirstSource(a.sources, b.sources);
}

function compareFirstSource(a: readonly SourceRef[], b: readonly SourceRef[]): number {
  const first = a[0];
  const second = b[0];
  if (first === undefined || second === undefined) return a.length - b.length;
  return compareSources(first, second);
}
