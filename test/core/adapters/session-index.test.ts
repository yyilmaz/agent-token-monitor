// Pins ADR 0016 in the Claude Code adapter: log titles, desktop session index files, side-session links.
// All IDs and titles are invented (R-70).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLAUDE_CODE_FILE_PATTERN, CLAUDE_CODE_INDEX_FILE_PATTERN, combineClaudeCode, parseClaudeCode, readClaudeCodeFile } from "../../../src/core/adapters/claude-code/index.js";
import type { LogFile } from "../../../src/core/host/index.js";

let request = 0;
function assistant(iso: string): string {
  request += 1;
  return JSON.stringify({
    type: "assistant",
    timestamp: iso,
    cwd: "/work/demo",
    requestId: `req_${request}`,
    message: { model: "m", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
  });
}

const title = (text: string) => JSON.stringify({ type: "custom-title", customTitle: text, sessionId: "x" });

const log = (session: string, lines: string[]): LogFile => ({ logRoot: "claudeCode:0", file: `-work-demo/${session}.jsonl`, lines });
const subagent = (parent: string, id: string): LogFile => ({
  logRoot: "claudeCode:0",
  file: `-work-demo/${parent}/subagents/agent-${id}.jsonl`,
  lines: [assistant("2026-10-31T10:05:00.000Z")],
});
const meta = (parent: string, id: string, lines: string[]): LogFile => ({ logRoot: "claudeCode:0", file: `-work-demo/${parent}/subagents/agent-${id}.meta.json`, lines });
const index = (desktopId: string, body: Record<string, unknown>): LogFile => ({
  logRoot: "claudeCodeIndex:0",
  file: `acct/org/local_${desktopId}.json`,
  lines: JSON.stringify({ sessionId: `local_${desktopId}`, lastTurnReport: "SECRET REPORT TEXT", ...body }, null, 2).split("\n"),
});

const FILES: LogFile[] = [
  log("main", [title("old name"), assistant("2026-10-31T10:00:00.000Z"), title("Open tasks and status")]),
  log("side1", [assistant("2026-10-31T10:01:00.000Z")]),
  log("side2-old", [assistant("2026-10-31T09:00:00.000Z")]),
  log("side2", [assistant("2026-10-31T10:02:00.000Z")]),
  log("orphan", [assistant("2026-10-31T10:03:00.000Z")]),
  subagent("main", "a1"),
  meta("main", "a1", JSON.stringify({ agentType: "general-purpose", description: "Run the tests", toolUseId: "SECRET TOOL ID" }, null, 2).split("\n")),
  subagent("main", "a2"),
  meta("main", "a2", ["{ not json"]),
  index("A", { cliSessionId: "main", title: "Main from the app" }),
  index("B", { cliSessionId: "side1", title: "Fix the parser", spawnedFrom: { sessionId: "local_A", sideSession: true } }),
  index("C", { cliSessionId: "side2", priorCliSessionIds: ["side2-old"], title: "Write docs", spawnedFrom: { sessionId: "local_A" } }),
  index("D", { cliSessionId: "orphan", title: "Lost parent", spawnedFrom: { sessionId: "local_GONE" } }),
  { logRoot: "claudeCodeIndex:0", file: "acct/org/local_E.json", lines: ["{ not json"] },
];

describe("Claude Code session titles and side sessions (ADR 0016)", () => {
  const output = parseClaudeCode(FILES);
  const byId = new Map(output.sessions.map((s) => [s.nativeId, s]));

  it("matches index files at any depth below the index root", () => {
    assert.ok(CLAUDE_CODE_INDEX_FILE_PATTERN.test("a/b/local_x.json"));
    assert.ok(!CLAUDE_CODE_INDEX_FILE_PATTERN.test("a/b/scheduled-tasks.json"));
  });

  it("takes the index title over the log's last custom-title, and the log title when there is no index", () => {
    assert.equal(byId.get("main")?.title, "Main from the app");
    const logOnly = parseClaudeCode(FILES.slice(0, 1));
    assert.equal(logOnly.sessions[0]?.title, "Open tasks and status");
  });

  it("titles a subagent with its meta file's description, and keeps nothing else of it (R-18)", () => {
    assert.ok(CLAUDE_CODE_FILE_PATTERN.test("p/s/subagents/agent-a1.meta.json"));
    assert.ok(!CLAUDE_CODE_FILE_PATTERN.test("p/s/subagents/agent-a1.prefix.json"));
    assert.equal(byId.get("main/agent-a1")?.title, "Run the tests");
    assert.equal(byId.get("main/agent-a2")?.title, null);
    assert.ok(!JSON.stringify(output).includes("SECRET TOOL ID"));
  });

  it("links a side session to its starter through recorded IDs only", () => {
    assert.equal(byId.get("side1")?.spawnedBySessionId, "claudeCode:main");
    assert.equal(byId.get("side1")?.isSubagent, false);
    assert.equal(byId.get("main")?.spawnedBySessionId, null);
    assert.equal(byId.get("main/agent-a1")?.parentSessionId, "claudeCode:main");
    assert.equal(byId.get("main/agent-a1")?.spawnedBySessionId, null);
  });

  it("applies an index entry to the earlier log sessions of the same desktop session", () => {
    assert.deepEqual([byId.get("side2-old")?.title, byId.get("side2-old")?.spawnedBySessionId], ["Write docs", "claudeCode:main"]);
  });

  it("leaves an unresolvable starter null and reports it, as it does an unreadable index or meta file (R-23)", () => {
    assert.equal(byId.get("orphan")?.spawnedBySessionId, null);
    assert.equal(byId.get("orphan")?.title, "Lost parent");
    assert.deepEqual(output.diagnostics.map((d) => d.code).sort(), ["invalidIndexFile", "invalidMetaFile", "unresolvedSideSessionLink"]);
  });

  it("keeps nothing else from the index file (R-18)", () => {
    assert.ok(!JSON.stringify(output).includes("SECRET REPORT TEXT"));
    assert.ok(!JSON.stringify(FILES.map(readClaudeCodeFile)).includes("SECRET REPORT TEXT"));
  });

  it("does not depend on the order of file results (ADR 0014)", () => {
    const results = FILES.map(readClaudeCodeFile);
    assert.equal(JSON.stringify(combineClaudeCode([...results].reverse())), JSON.stringify(output));
  });
});
