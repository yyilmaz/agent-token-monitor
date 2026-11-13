// ADR 0018 and R-10, R-16–R-23, R-70. Fixtures are synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { combineCodex, parseCodex, readCodexFile } from "../../../src/core/adapters/codex/index.js";
import type { LogFile } from "../../../src/core/host/index.js";

function fixture(name: string): LogFile {
  const file = `2026/10/31/rollout-${name}.jsonl`;
  const text = readFileSync(new URL(`../../../../test/fixtures/codex/${file}`, import.meta.url), "utf8");
  return { logRoot: "codex:0", file, lines: text.split("\n") };
}

describe("Codex rollout adapter (ADR 0018)", () => {
  const mixed = fixture("mixed");
  const legacy = fixture("legacy");

  it("counts a request and its snapshot once, and counts new legacy usage after a repeated total (COD-1–3)", () => {
    const result = parseCodex([mixed]);
    assert.equal(result.sessions[0]?.projectPath, "/fixture/project");
    assert.deepEqual(result.calls.map((call) => [
      call.model, call.inputUncached, call.cacheRead, call.cacheWrite, call.output, call.reasoning,
      call.sources.map((source) => source.line),
    ]), [
      ["fixture-model", 40, 60, 0, 20, 5, [4, 5]],
      ["fixture-model-next", 20, 10, null, 10, null, [10]],
    ]);
    assert.deepEqual(result.events.map(({ type, compaction }) => [type, compaction]), [["userTurn", null], ["compaction", null]]);
    assert.deepEqual(result.quotaSamples.map((sample) => [
      sample.window, sample.windowSeconds, sample.usedPercent, sample.resetsAt, sample.sources[0]?.line,
    ]), [["primary", 18000, 12.5, 1793451600000, 6], ["secondary", null, 20, null, 6]]);
    assert.deepEqual(result.diagnostics, []);
  });

  it("reads an initial legacy snapshot, preserves unknowns and reports unreadable lines (COD-1–4)", () => {
    const result = parseCodex([legacy]);
    assert.equal(result.sessions[0]?.isSubagent, true);
    assert.equal(result.sessions[0]?.parentSessionId, "codex:fixture-main");
    assert.deepEqual(result.calls.map((call) => [
      call.model, call.inputUncached, call.cacheRead, call.cacheWrite, call.output, call.reasoning,
    ]), [[null, null, null, null, 4, null]]);
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.sources[0]?.line]), [
      ["unsupportedUsage", 4], ["invalidJson", 5],
    ]);
  });

  it("fills tool names and STEP-1 shell classes from the tool calls before each request (ADR 0017, R-18)", () => {
    // Kept outside the Codex fixture root so the server tests' file counts stay unchanged.
    const text = readFileSync(new URL("../../../../test/fixtures/codex-tools/rollout-tools.jsonl", import.meta.url), "utf8");
    const result = parseCodex([{ logRoot: "codex:0", file: "rollout-tools.jsonl", lines: text.split("\n") }]);
    assert.deepEqual(result.calls.map((call) => [call.toolNames, call.shellClasses]), [
      [["exec_command"], ["explore"]],
      [["apply_patch", "exec_command"], ["explore"]],
      [["exec_command", "local_shell", "sleep"], ["other", "explore"]],
    ]);
    assert.equal(JSON.stringify(result).includes("pattern"), false);
    assert.deepEqual(result.diagnostics, []);
  });

  it("emits a user turn from task_started, once per turn when user_message follows (ADR 0017 STEPS-1)", () => {
    const text = readFileSync(new URL("../../../../test/fixtures/codex-tools/rollout-tools.jsonl", import.meta.url), "utf8");
    const result = parseCodex([{ logRoot: "codex:0", file: "rollout-tools.jsonl", lines: text.split("\n") }]);
    assert.deepEqual(result.events.map((e) => [e.type, e.sources[0]?.line]), [["userTurn", 3], ["userTurn", 11]]);
  });

  it("combines copied requests across roots and gives the same output as parsing the files (COD-2, COD-4)", () => {
    const copy = { ...mixed, logRoot: "codex:1" };
    const snapshotOnly = { ...mixed, logRoot: "codex:2", lines: mixed.lines.filter((_, index) => index !== 3) };
    const files = [mixed, legacy, copy, snapshotOnly];
    const direct = parseCodex(files);
    assert.equal(direct.calls.length, 3);
    assert.equal(direct.calls[0]?.id, "codex:fixture-main:response:fixture-response");
    assert.equal(direct.calls[0]?.sources.length, 5);
    assert.deepEqual(combineCodex(files.map(readCodexFile).reverse()), direct);
  });

  it("keeps two requests with identical per-call counts when their cumulative totals differ (COD-2)", () => {
    const lines = mixed.lines.slice(0, 4);
    const secondSnapshot = mixed.lines[4]?.replace('"total_token_usage":{"total_tokens":120}', '"total_token_usage":{"total_tokens":240}');
    assert.ok(secondSnapshot);
    const { calls } = parseCodex([{ ...mixed, lines: [...lines, secondSnapshot] }]);
    assert.deepEqual(calls.map((call) => call.id), [
      "codex:fixture-main:response:fixture-response", "codex:fixture-main:total:240",
    ]);
  });
});
