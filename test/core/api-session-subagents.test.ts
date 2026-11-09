// Pins the subagent order of the session view (ADR 0016, R-16): newest last call first, no calls last.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { analyze, session } from "../../src/core/api/index.js";
import { loadConfig } from "../../src/core/config/config.js";
import type { Call, Session } from "../../src/core/model/index.js";

const DEFAULTS_PATH = fileURLToPath(new URL("../../../config/default.json", import.meta.url));

const sess = (id: string, parent: string | null): Session => ({
  id,
  harness: "claudeCode",
  nativeId: id,
  parentSessionId: parent,
  isSubagent: parent !== null,
  spawnedBySessionId: null,
  title: null,
  projectPath: null,
  sources: [],
});

const call = (id: string, sessionId: string, iso: string, line: number): Call => ({
  id,
  sessionId,
  timestamp: Date.parse(iso),
  model: null,
  kind: "turn",
  inputUncached: 1,
  cacheRead: 0,
  cacheWrite: 0,
  output: 1,
  reasoning: null,
  cacheWriteByTtlSeconds: null,
  toolNames: [],
  sources: [{ logRoot: "r:0", file: "f", line }],
});

describe("subagent order in the session view (ADR 0016)", () => {
  it("lists the newest last call first and a subagent without calls last", () => {
    const loaded = loadConfig({ defaults: { path: "d", text: readFileSync(DEFAULTS_PATH, "utf8") }, user: null });
    assert.ok(loaded.ok);
    const analysis = analyze(
      {
        sessions: [sess("main", null), sess("a", "main"), sess("b", "main"), sess("c", "main"), sess("d", "main")],
        calls: [call("1", "a", "2026-11-01T10:00:00Z", 1), call("2", "b", "2026-11-01T12:00:00Z", 2), call("3", "a", "2026-11-01T11:00:00Z", 3), call("4", "d", "2026-11-01T12:00:00Z", 4)],
        events: [],
        quotaSamples: [],
        diagnostics: [],
      },
      loaded.config,
      "UTC",
    );
    const view = session(analysis, Date.parse("2026-11-02T00:00:00Z"), "main");
    assert.ok(view);
    assert.deepEqual(view.children, ["b", "d", "a", "c"]);
    assert.equal(view.subagentLastCallAt["c"], null);
  });
});
