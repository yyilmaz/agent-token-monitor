// Pins Claude Code normalization (R-22, R-23, R-70, ADR 0008).
// Fixtures in test/fixtures/claude-code are synthetic and anonymized (R-18).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_CODE_FILE_PATTERN, parseClaudeCode } from "../../../src/core/adapters/claude-code/index.js";
import type { LogFile } from "../../../src/core/host/index.js";
import { FsLogSource, readLogFiles } from "../../../src/hosts/node/log-source.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../../../test/fixtures/claude-code/projects", import.meta.url));
const ROOT = "claudeCode:0";
const A = "-fixture-project/session-a.jsonl";
const B = "-fixture-project/session-b.jsonl";
const SUB = "-fixture-project/session-a/subagents/agent-sub1.jsonl";

const src = (file: string, line: number) => ({ logRoot: ROOT, file, line });
const ms = (iso: string) => Date.parse(iso);

async function fixtureFiles(): Promise<LogFile[]> {
  return readLogFiles(new FsLogSource({ [ROOT]: FIXTURE_ROOT }), [ROOT], CLAUDE_CODE_FILE_PATTERN);
}

describe("Claude Code adapter", async () => {
  const files = await fixtureFiles();
  const output = parseClaudeCode(files);
  const call = (id: string) => {
    const found = output.calls.find((c) => c.id === id);
    assert.ok(found, `call ${id} not found`);
    return found;
  };

  it("finds main session and subagent files", () => {
    assert.deepEqual(files.map((f) => f.file), [A, SUB, B]);
  });

  it("creates one session per file, subagents linked to their parent", () => {
    assert.deepEqual(
      output.sessions.map((s) => [s.id, s.parentSessionId, s.isSubagent, s.projectPath]),
      [
        ["claudeCode:session-a", null, false, "/fixture/project"],
        ["claudeCode:session-a/agent-sub1", "claudeCode:session-a", true, "/fixture/project"],
        ["claudeCode:session-b", null, false, "/fixture/project"],
      ],
    );
  });

  it("collapses all lines of one request into one call and counts it once", () => {
    assert.deepEqual(call("claudeCode:req-1"), {
      id: "claudeCode:req-1",
      sessionId: "claudeCode:session-a",
      timestamp: ms("2026-10-01T10:00:05.000Z"),
      model: "claude-opus-5-5",
      kind: "turn",
      inputUncached: 10,
      cacheRead: 0,
      cacheWrite: 30000,
      cacheWriteByTtlSeconds: { "300": 30000, "3600": 0 },
      output: 5,
      reasoning: 3,
      toolNames: ["Read"],
      shellClasses: [],
      // Lines copied into the forked session-b stay traceable, but the request is not counted twice.
      sources: [src(A, 2), src(A, 3), src(B, 2), src(B, 3)],
    });
  });

  it("takes the largest output of a request whose lines grow while streaming", () => {
    const req2 = call("claudeCode:req-2");
    assert.equal(req2.output, 25);
    assert.equal(req2.cacheRead, 30000);
    assert.deepEqual(req2.toolNames, ["Bash"]);
  });

  it("classifies each Bash call by STEP-1 and keeps only the class (R-18, ADR 0017)", () => {
    const req2 = call("claudeCode:req-2");
    assert.deepEqual(req2.shellClasses, ["explore", "edit"]);
    assert.equal(JSON.stringify(req2).includes("pattern"), false);
  });

  it("maps input_tokens directly to inputUncached (it excludes cached tokens)", () => {
    assert.equal(call("claudeCode:req-5").inputUncached, 2);
    assert.equal(call("claudeCode:req-5").cacheRead, 30000);
  });

  it("splits cache writes by declared lifetime: 5m → 300 s, 1h → 3600 s", () => {
    assert.deepEqual(call("claudeCode:req-3").cacheWriteByTtlSeconds, { "300": 0, "3600": 25000 });
  });

  it("keeps reasoning unknown when the log has no thinking-token detail (R-16)", () => {
    assert.equal(call("claudeCode:req-3").reasoning, null);
  });

  it("assigns subagent requests to the subagent session", () => {
    assert.equal(call("claudeCode:req-4").sessionId, "claudeCode:session-a/agent-sub1");
    assert.equal(call("claudeCode:req-4").model, "claude-sonnet-5-5");
  });

  it("records compaction as a call with every token field unknown (R-16)", () => {
    assert.deepEqual(call("claudeCode:compactionCall:c-1"), {
      id: "claudeCode:compactionCall:c-1",
      sessionId: "claudeCode:session-a",
      timestamp: ms("2026-10-01T10:30:00.000Z"),
      model: null,
      kind: "compaction",
      inputUncached: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      cacheWriteByTtlSeconds: null,
      toolNames: [],
      shellClasses: [],
      sources: [src(A, 8)],
    });
  });

  it("ignores synthetic placeholder messages", () => {
    assert.equal(output.calls.some((c) => c.sources.some((s) => s.file === A && s.line === 10)), false);
  });

  it("returns calls in canonical order (R-10)", () => {
    assert.deepEqual(
      output.calls.map((c) => c.id),
      [
        "claudeCode:req-1",
        "claudeCode:req-4",
        "claudeCode:req-2",
        "claudeCode:compactionCall:c-1",
        "claudeCode:req-3",
        "claudeCode:req-5",
      ],
    );
  });

  it("emits user turns, subagent spawn, compaction and error events only", () => {
    assert.deepEqual(
      output.events.map((e) => [e.id, e.sessionId, e.type, e.childSessionId]),
      [
        ["claudeCode:userTurn:u-1", "claudeCode:session-a", "userTurn", null],
        ["claudeCode:subagentSpawn:session-a/agent-sub1", "claudeCode:session-a", "subagentSpawn", "claudeCode:session-a/agent-sub1"],
        ["claudeCode:compaction:c-1", "claudeCode:session-a", "compaction", null],
        ["claudeCode:error:e-1", "claudeCode:session-a", "error", null],
      ],
    );
  });

  it("carries compactMetadata on the compaction event, a missing field as null (COMPACT-1, ADR 0017)", () => {
    assert.deepEqual(
      output.events.map((e) => [e.type, e.compaction]),
      [
        ["userTurn", null],
        ["subagentSpawn", null],
        // The fixture line logs trigger and preTokens but no postTokens.
        ["compaction", { trigger: "manual", preTokens: 30235, postTokens: null }],
        ["error", null],
      ],
    );
  });

  it("reports unreadable lines instead of skipping them silently (R-23)", () => {
    assert.deepEqual(output.diagnostics, [
      {
        harness: "claudeCode",
        severity: "warning",
        code: "invalidJson",
        message: "Line is not valid JSON; skipped.",
        sources: [src(A, 7)],
      },
    ]);
  });

  it("produces identical output regardless of file order (R-10)", () => {
    assert.deepEqual(parseClaudeCode([...files].reverse()), output);
  });

  it("carries no log content: no redacted text reaches the model (R-18)", () => {
    assert.equal(JSON.stringify(output).includes("<redacted>"), false);
  });
});

describe("Claude Code adapter edge cases", () => {
  const file = (lines: readonly unknown[]): LogFile => ({
    logRoot: ROOT,
    file: "p/s.jsonl",
    lines: lines.map((line) => JSON.stringify(line)),
  });
  const assistantLine = (usage: unknown) => ({
    type: "assistant",
    timestamp: "2026-10-01T10:00:00.000Z",
    requestId: "r",
    message: { model: "m", content: [], usage },
  });

  it("treats a missing usage field as unknown, never as zero (R-16)", () => {
    const [only] = parseClaudeCode([file([assistantLine({ input_tokens: 1, output_tokens: 2 })])]).calls;
    assert.equal(only?.cacheRead, null);
    assert.equal(only?.cacheWrite, null);
    assert.equal(only?.cacheWriteByTtlSeconds, null);
  });

  it("reports an invalid token count and treats it as unknown", () => {
    const output = parseClaudeCode([file([assistantLine({ input_tokens: -1, output_tokens: 2 })])]);
    assert.equal(output.calls[0]?.inputUncached, null);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["invalidTokenCount"]);
  });

  it("reports lines without a valid timestamp", () => {
    const output = parseClaudeCode([file([{ ...assistantLine({}), timestamp: "yesterday" }])]);
    assert.equal(output.calls.length, 0);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["invalidTimestamp"]);
  });

  it("reports files outside the known layout", () => {
    const output = parseClaudeCode([{ logRoot: ROOT, file: "loose.jsonl", lines: [] }]);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["unexpectedPath"]);
  });
});
