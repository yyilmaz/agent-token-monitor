// OpenCode adapter tests (ADR 0022, R-10, R-16, R-18, R-22, R-23).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  combineOpenCode,
  opencodeCapabilities,
  parseOpenCodeFiles,
  readOpenCodeFile,
} from "../../../src/core/adapters/opencode/index.js";
import type { LogFile } from "../../../src/core/host/index.js";

const FIXTURE_PATH = fileURLToPath(new URL("../../../../test/fixtures/opencode/opencode.jsonl", import.meta.url));
const fixtureFile = (logRoot = "opencode:0", file = "opencode.db"): LogFile => ({
  logRoot,
  file,
  lines: readFileSync(FIXTURE_PATH, "utf8").split(/\r?\n/),
});

describe("OpenCode adapter (ADR 0022)", () => {
  it("declares recorded capabilities for all five token fields (R-22)", () => {
    assert.deepEqual(opencodeCapabilities, {
      inputUncached: { kind: "recorded" },
      cacheRead: { kind: "recorded" },
      cacheWrite: { kind: "recorded" },
      output: { kind: "recorded" },
      reasoning: { kind: "recorded" },
    });
  });

  it("normalizes sessions, subagents, calls, events, and tools without retaining redacted text (R-16, R-18)", () => {
    const out = parseOpenCodeFiles([fixtureFile()]);

    assert.equal(out.sessions.length, 2);
    const main = out.sessions.find((s) => s.nativeId === "sess-main");
    const sub = out.sessions.find((s) => s.nativeId === "sess-sub");
    assert.ok(main && sub);
    assert.equal(main.isSubagent, false);
    assert.equal(main.parentSessionId, null);
    assert.equal(main.title, "Fix build");
    assert.equal(main.projectPath, "/workspace/app");
    assert.equal(sub.isSubagent, true);
    assert.equal(sub.parentSessionId, "opencode:sess-main");

    // 2 assistant calls + 1 compaction call + 1 invalid-token assistant call = 4 calls
    assert.equal(out.calls.length, 4);
    const c1 = out.calls.find((c) => c.id === "opencode:msg-a1");
    assert.ok(c1);
    assert.equal(c1.timestamp, 1793000005000);
    assert.equal(c1.model, "model-alpha");
    assert.equal(c1.inputUncached, 1200);
    assert.equal(c1.cacheRead, 4096);
    assert.equal(c1.cacheWrite, 512);
    assert.equal(c1.output, 100);
    assert.equal(c1.reasoning, 150);
    assert.deepEqual(c1.toolNames, ["read", "shell"]);
    assert.deepEqual(c1.shellClasses, ["explore"]);

    const c2 = out.calls.find((c) => c.id === "opencode:msg-a2");
    assert.ok(c2);
    assert.equal(c2.cacheRead, null);
    assert.equal(c2.cacheWrite, null);
    assert.equal(c2.reasoning, null);
    assert.deepEqual(c2.shellClasses, ["edit"]);

    const comp = out.calls.find((c) => c.id === "opencode:compactionCall:msg-c1");
    assert.ok(comp);
    assert.equal(comp.kind, "compaction");
    assert.equal(comp.cacheWrite, 20000);

    const bad = out.calls.find((c) => c.id === "opencode:msg-a3");
    assert.ok(bad);
    assert.equal(bad.inputUncached, null);
    assert.equal(bad.output, 25);

    assert.deepEqual(
      out.events.map((e) => e.type),
      ["userTurn", "subagentSpawn", "compaction"],
    );

    // Diagnostics for bad token count and malformed line (R-23)
    assert.deepEqual(
      out.diagnostics.map((d) => d.code),
      ["opencode_invalid_token_count", "opencode_malformed_line"],
    );

    // No redacted text or raw shell command leaks into normalized output (R-18)
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes("secret-redacted"), false);
    assert.equal(serialized.includes("not-valid-json-redacted-text"), false);
  });

  it("combineOpenCode over per-file results equals parseOpenCodeFiles regardless of input order (ADR 0014, R-10)", () => {
    const f1 = fixtureFile("opencode:0", "opencode.db");
    const f2: LogFile = {
      logRoot: "opencode:1",
      file: "opencode.db",
      lines: [
        JSON.stringify({ record: "session", id: "sess-other", parentId: null, projectPath: "/workspace/other", title: "Other", timeCreated: 1793000050000 }),
        JSON.stringify({ record: "part", messageId: "msg-o1", sessionId: "sess-other", tool: { name: "grep", command: null } }),
        JSON.stringify({ record: "message", id: "msg-o1", sessionId: "sess-other", type: "assistant", seq: 1, timeCreated: 1793000051000, time: { completed: 1793000052000 }, model: { id: "model-alpha" }, tokens: { input: 50, output: 10 }, tools: [] }),
      ],
    };
    const a = JSON.stringify(parseOpenCodeFiles([f1, f2]));
    const b = JSON.stringify(combineOpenCode([readOpenCodeFile(f2), readOpenCodeFile(f1)]));
    assert.equal(a, b);
  });
});
