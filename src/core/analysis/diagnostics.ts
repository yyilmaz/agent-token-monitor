// Groups adapter diagnostics for the Diagnostics view (R-23, ADR 0013). Pure and deterministic (R-10, R-11).
// The explanations are fixed English text per diagnostic code. They never contain log content (R-18).

import type { Diagnostic, HarnessId, SourceRef } from "../model/index.js";
import { compareSources, compareStrings } from "../order.js";

/** What a diagnostic code means and what it does to the figures, in words. */
export interface CodeExplanation {
  readonly title: string;
  readonly effect: string;
}

export const CODE_EXPLANATIONS: Readonly<Record<string, CodeExplanation>> = {
  unexpectedPath: { title: "Log file in an unknown place", effect: "The whole file was ignored." },
  invalidJson: { title: "Line is not valid JSON", effect: "That line was ignored; its tokens are missing from every total." },
  unexpectedLine: { title: "Line has an unknown shape", effect: "That line was ignored; its tokens are missing from every total." },
  invalidTimestamp: { title: "Line has no usable timestamp", effect: "That line was ignored; its tokens are missing from every total." },
  missingMessage: { title: "Assistant line has no message", effect: "That line was ignored; its tokens are missing from every total." },
  missingRequestId: { title: "Assistant line has no request ID", effect: "That line was ignored; its tokens are missing from every total." },
  missingUsage: { title: "Request has no token counts", effect: "The request is shown with unknown tokens (R-16)." },
  invalidTokenCount: { title: "A token count is not a valid number", effect: "That field is shown as unknown; the other fields of the request are kept (R-16)." },
  inconsistentUsage: { title: "Lines of one request disagree", effect: "The final line of the request was used." },
  unsupportedUsage: { title: "Token record the adapter does not support", effect: "That record was ignored; its tokens are missing from every total." },
  missingSession: { title: "File has no session information", effect: "The file's calls were read but are not attached to a session." },
  invalidStepIndex: { title: "Step has no valid index", effect: "That step was ignored; its tokens are missing from every total." },
  duplicateStep: { title: "Step index used twice", effect: "The later step was ignored, so it is not counted twice." },
  invalidSubagentLink: { title: "Subagent file has no valid conversation", effect: "The subagent is not linked to its parent session." },
  conflictingParent: { title: "Subagent claims several parents", effect: "The lowest parent ID was used for the link." },
  missingSpawnStep: { title: "Parent step of a subagent not found", effect: "The subagent is linked, but no spawn event is shown." },
  unresolvedSideSessionLink: { title: "Starting session of a side session not found", effect: "No link to the starting session is shown." },
  invalidMetaFile: { title: "Subagent title file is unreadable", effect: "The subagent has no title." },
  invalidIndexFile: { title: "Session index file is unreadable", effect: "Titles and side-session links from that file are missing." },
  unexpectedIndexFile: { title: "Session index file has an unknown shape", effect: "Titles and side-session links from that file are missing." },
};

export interface DiagnosticGroup {
  readonly harness: HarnessId;
  readonly severity: Diagnostic["severity"];
  readonly code: string;
  /** Plain-language name of the code; the code itself when no explanation exists. */
  readonly title: string;
  /** What the problem does to the figures; null when no explanation exists. */
  readonly effect: string | null;
  /** The adapter's own fixed message. */
  readonly message: string;
  readonly count: number;
  /** Distinct log files the diagnostics point to. */
  readonly files: number;
  /** The first `locationsShown` locations in file order; `count` says how many exist. */
  readonly locations: readonly SourceRef[];
}

export interface DiagnosticSummary {
  readonly errors: number;
  readonly warnings: number;
  /** Distinct log files with at least one diagnostic. */
  readonly files: number;
}

const fileKey = (s: SourceRef) => `${s.logRoot}\u0000${s.file}`;

export function groupDiagnostics(list: readonly Diagnostic[], locationsShown: number): {
  readonly summary: DiagnosticSummary;
  readonly groups: readonly DiagnosticGroup[];
} {
  const buckets = new Map<string, Diagnostic[]>();
  for (const d of list) {
    const key = [d.harness, d.severity, d.code, d.message].join("\u0000");
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [d]);
    else bucket.push(d);
  }
  const groups: DiagnosticGroup[] = [];
  for (const items of buckets.values()) {
    const first = items[0] as Diagnostic;
    const sources = items.flatMap((d) => d.sources).sort(compareSources);
    const explanation = CODE_EXPLANATIONS[first.code];
    groups.push({
      harness: first.harness,
      severity: first.severity,
      code: first.code,
      title: explanation?.title ?? first.code,
      effect: explanation?.effect ?? null,
      message: first.message,
      count: items.length,
      files: new Set(sources.map(fileKey)).size,
      locations: sources.slice(0, locationsShown),
    });
  }
  // Errors before warnings, then the most frequent first; ties by harness, code and message.
  groups.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      b.count - a.count ||
      compareStrings(a.harness, b.harness) ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  );
  return {
    summary: {
      errors: list.filter((d) => d.severity === "error").length,
      warnings: list.filter((d) => d.severity === "warning").length,
      files: new Set(list.flatMap((d) => d.sources).map(fileKey)).size,
    },
    groups,
  };
}
