// Pins the grouping of adapter diagnostics for the Diagnostics view (R-23, R-10, ADR 0013).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CODE_EXPLANATIONS, groupDiagnostics } from "../../../src/core/analysis/diagnostics.js";
import type { Diagnostic } from "../../../src/core/model/index.js";

const d = (code: string, file: string, line: number, severity: Diagnostic["severity"] = "warning", harness: Diagnostic["harness"] = "claudeCode", message = `msg ${code}`): Diagnostic => ({
  harness, severity, code, message, sources: [{ logRoot: `${harness}:0`, file, line }],
});

describe("groupDiagnostics (R-23)", () => {
  it("groups by harness, severity, code and message, and counts files", () => {
    const { groups, summary } = groupDiagnostics(
      [d("invalidJson", "b.jsonl", 3), d("invalidJson", "a.jsonl", 9), d("invalidJson", "a.jsonl", 2), d("missingUsage", "a.jsonl", 1)],
      10,
    );
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => [g.code, g.count, g.files]), [["invalidJson", 3, 2], ["missingUsage", 1, 1]]);
    assert.deepEqual(summary, { errors: 0, warnings: 4, files: 2 });
  });

  it("lists locations in file order and only as many as configured", () => {
    const { groups } = groupDiagnostics([d("invalidJson", "b.jsonl", 1), d("invalidJson", "a.jsonl", 9), d("invalidJson", "a.jsonl", 2)], 2);
    assert.deepEqual(groups[0]?.locations.map((s) => `${s.file}:${s.line}`), ["a.jsonl:2", "a.jsonl:9"]);
    assert.equal(groups[0]?.count, 3);
  });

  it("orders errors first, then by count, then harness and code", () => {
    const { groups } = groupDiagnostics(
      [
        d("missingUsage", "a", 1),
        d("invalidJson", "a", 1), d("invalidJson", "a", 2),
        d("unexpectedLine", "a", 1, "error"),
        d("invalidJson", "a", 1, "warning", "codex"),
      ],
      5,
    );
    assert.deepEqual(groups.map((g) => `${g.severity}:${g.harness}:${g.code}`), [
      "error:claudeCode:unexpectedLine",
      "warning:claudeCode:invalidJson",
      "warning:claudeCode:missingUsage",
      "warning:codex:invalidJson",
    ]);
  });

  it("separates messages of one code and explains codes; unknown codes fall back to the code", () => {
    const { groups } = groupDiagnostics([d("invalidTokenCount", "a", 1, "warning", "claudeCode", "Field x"), d("invalidTokenCount", "a", 2, "warning", "claudeCode", "Field y"), d("novelCode", "a", 3)], 5);
    assert.equal(groups.filter((g) => g.code === "invalidTokenCount").length, 2);
    const novel = groups.find((g) => g.code === "novelCode");
    assert.deepEqual([novel?.title, novel?.effect], ["novelCode", null]);
    assert.ok(CODE_EXPLANATIONS["invalidTokenCount"]);
  });

  it("returns an empty result for no diagnostics", () => {
    assert.deepEqual(groupDiagnostics([], 5), { summary: { errors: 0, warnings: 0, files: 0 }, groups: [] });
  });
});
