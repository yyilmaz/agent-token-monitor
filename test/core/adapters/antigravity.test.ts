// Pins Antigravity normalization (R-22, R-23, R-70, ADR 0008).
// Fixtures in test/fixtures/antigravity are synthetic and anonymized (R-18).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANTIGRAVITY_FILE_PATTERN,
  antigravityCapabilities,
  parseAntigravity,
} from "../../../src/core/adapters/antigravity/index.js";
import type { LogFile } from "../../../src/core/host/index.js";
import { FsLogSource, readLogFiles } from "../../../src/hosts/node/log-source.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../../../test/fixtures/antigravity/brain", import.meta.url));
const ROOT = "antigravity:0";
const PARENT = "conv-root/.system_generated/logs/transcript.jsonl";
const CHILD = "conv-child/.system_generated/logs/transcript.jsonl";
const LINK = "conv-root/.system_generated/subagents/conv-child.json";

const src = (file: string, line: number) => ({ logRoot: ROOT, file, line });
const ms = (iso: string) => Date.parse(iso);

async function fixtureFiles(): Promise<LogFile[]> {
  return readLogFiles(new FsLogSource({ [ROOT]: FIXTURE_ROOT }), [ROOT], ANTIGRAVITY_FILE_PATTERN);
}

describe("Antigravity adapter", async () => {
  const files = await fixtureFiles();
  const output = parseAntigravity(files);
  const call = (id: string) => {
    const found = output.calls.find((c) => c.id === id);
    assert.ok(found, `call ${id} not found`);
    return found;
  };

  it("finds transcripts and subagent links", () => {
    assert.deepEqual(files.map((f) => f.file), [CHILD, PARENT, LINK]);
  });

  it("creates one session per conversation, subagents linked to their parent", () => {
    assert.deepEqual(
      output.sessions.map((s) => [s.id, s.parentSessionId, s.isSubagent, s.projectPath, s.sources]),
      [
        ["antigravity:conv-child", "antigravity:conv-root", true, null, [src(CHILD, 1), src(LINK, 1)]],
        ["antigravity:conv-root", null, false, null, [src(PARENT, 1)]],
      ],
    );
  });

  it("maps a planner step to one call: input_tokens is uncached, cache writes are 0 by billing", () => {
    assert.deepEqual(call("antigravity:conv-root:4"), {
      id: "antigravity:conv-root:4",
      sessionId: "antigravity:conv-root",
      timestamp: ms("2026-10-02T09:00:08Z"),
      model: null,
      kind: "turn",
      inputUncached: 200,
      cacheRead: 30000,
      cacheWrite: 0,
      output: 20,
      reasoning: null,
      cacheWriteByTtlSeconds: null,
      toolNames: ["invoke_subagent"],
      shellClasses: [],
      sources: [src(PARENT, 5)],
    });
  });

  it("declares cache writes as zero by billing and reasoning as not recorded", () => {
    assert.equal(antigravityCapabilities.cacheWrite.kind, "zeroByBilling");
    assert.equal(antigravityCapabilities.reasoning.kind, "notRecorded");
  });

  it("lists each tool name once, in first-use order", () => {
    assert.deepEqual(call("antigravity:conv-child:1").toolNames, ["run_command", "read_file"]);
    assert.equal(call("antigravity:conv-child:1").sessionId, "antigravity:conv-child");
  });

  it("classifies each run_command by STEP-1, decoding a JSON-quoted command line (R-18, ADR 0017)", () => {
    assert.deepEqual(call("antigravity:conv-child:1").shellClasses, ["explore", "edit"]);
  });

  it("keeps every token field unknown for a planner step without token counts (R-16)", () => {
    const c = call("antigravity:conv-root:6");
    assert.deepEqual([c.inputUncached, c.cacheRead, c.cacheWrite, c.output], [null, null, null, null]);
    assert.deepEqual(c.toolNames, ["view_file"]);
  });

  it("records a checkpoint as a compaction call with every token field unknown (R-16)", () => {
    assert.deepEqual(call("antigravity:compactionCall:conv-root:7"), {
      id: "antigravity:compactionCall:conv-root:7",
      sessionId: "antigravity:conv-root",
      timestamp: ms("2026-10-02T09:30:00Z"),
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
      sources: [src(PARENT, 9)],
    });
  });

  it("returns calls in canonical order across conversations (R-10)", () => {
    assert.deepEqual(
      output.calls.map((c) => c.id),
      [
        "antigravity:conv-root:2",
        "antigravity:conv-root:4",
        "antigravity:conv-child:1",
        "antigravity:conv-root:6",
        "antigravity:compactionCall:conv-root:7",
        "antigravity:conv-root:8",
        "antigravity:conv-root:10",
      ],
    );
  });

  it("emits user turns, subagent spawn at the parent's spawn step, compaction and error events", () => {
    assert.deepEqual(
      output.events.map((e) => [e.id, e.sessionId, e.type, e.childSessionId, e.timestamp, e.sources]),
      [
        ["antigravity:userTurn:conv-root:1", "antigravity:conv-root", "userTurn", null, ms("2026-10-02T09:00:01Z"), [src(PARENT, 2)]],
        [
          "antigravity:subagentSpawn:conv-child",
          "antigravity:conv-root",
          "subagentSpawn",
          "antigravity:conv-child",
          ms("2026-10-02T09:00:09Z"),
          [src(PARENT, 6), src(LINK, 1)],
        ],
        ["antigravity:compaction:conv-root:7", "antigravity:conv-root", "compaction", null, ms("2026-10-02T09:30:00Z"), [src(PARENT, 9)]],
        ["antigravity:error:conv-root:9", "antigravity:conv-root", "error", null, ms("2026-10-02T09:30:04Z"), [src(PARENT, 11)]],
      ],
    );
  });

  it("reports unreadable, token-less and duplicate steps instead of skipping them silently (R-23)", () => {
    assert.deepEqual(
      output.diagnostics.map((d) => [d.code, d.severity, d.sources]),
      [
        ["invalidJson", "warning", [src(PARENT, 7)]],
        ["missingUsage", "warning", [src(PARENT, 8)]],
        ["duplicateStep", "warning", [src(PARENT, 12)]],
      ],
    );
  });

  it("produces identical output regardless of file order (R-10)", () => {
    assert.deepEqual(parseAntigravity([...files].reverse()), output);
  });

  it("carries no log content: no redacted text reaches the model (R-18)", () => {
    assert.equal(JSON.stringify(output).includes("<redacted>"), false);
  });
});

describe("Antigravity adapter edge cases", () => {
  const transcript = (conversation: string, steps: readonly unknown[]): LogFile => ({
    logRoot: ROOT,
    file: `${conversation}/.system_generated/logs/transcript.jsonl`,
    lines: steps.map((step) => JSON.stringify(step)),
  });
  const planner = (fields: Record<string, unknown>) => ({
    type: "PLANNER_RESPONSE",
    step_index: 1,
    created_at: "2026-10-02T09:00:00Z",
    ...fields,
  });

  it("treats a missing cache-read field as unknown, never as zero (R-16)", () => {
    const [only] = parseAntigravity([transcript("c", [planner({ input_tokens: 1, output_tokens: 2 })])]).calls;
    assert.equal(only?.cacheRead, null);
    assert.equal(only?.cacheWrite, 0);
  });

  it("reports an invalid token count and treats it as unknown", () => {
    const output = parseAntigravity([transcript("c", [planner({ input_tokens: -1, cache_read_tokens: 0, output_tokens: 2 })])]);
    assert.equal(output.calls[0]?.inputUncached, null);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["invalidTokenCount"]);
  });

  it("reports steps without a valid timestamp or step index", () => {
    const output = parseAntigravity([
      transcript("c", [planner({ created_at: "yesterday" }), planner({ step_index: "x" })]),
    ]);
    assert.equal(output.calls.length, 0);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["invalidTimestamp", "invalidStepIndex"]);
  });

  it("reports a subagent link whose spawn step is missing, and still links the child", () => {
    const link: LogFile = {
      logRoot: ROOT,
      file: "p/.system_generated/subagents/k.json",
      lines: [JSON.stringify({ conversationId: "k", spawnStepIndex: 99 })],
    };
    const output = parseAntigravity([transcript("p", [planner({})]), transcript("k", [planner({})]), link]);
    assert.equal(output.sessions.find((s) => s.id === "antigravity:k")?.parentSessionId, "antigravity:p");
    assert.equal(output.events.length, 0);
    assert.ok(output.diagnostics.some((d) => d.code === "missingSpawnStep"));
  });

  it("reports an invalid subagent link", () => {
    const link: LogFile = { logRoot: ROOT, file: "p/.system_generated/subagents/k.json", lines: ["{}"] };
    assert.deepEqual(parseAntigravity([link]).diagnostics.map((d) => d.code), ["invalidSubagentLink"]);
  });

  it("reads conversation titles from .pbtxt annotation files (ADR 0016)", () => {
    const annotation: LogFile = {
      logRoot: "antigravityIndex:0",
      file: "c.pbtxt",
      lines: ['title:"Example \\"Title\\"" last_user_view_time:{seconds:100 nanos:0}'],
    };
    const output = parseAntigravity([transcript("c", [planner({ input_tokens: 1, cache_read_tokens: 0, output_tokens: 2 })]), annotation]);
    assert.equal(output.sessions[0]?.title, 'Example "Title"');
  });

  it("reports files outside the known layout", () => {
    const output = parseAntigravity([{ logRoot: ROOT, file: "loose.jsonl", lines: [] }]);
    assert.deepEqual(output.diagnostics.map((d) => d.code), ["unexpectedPath"]);
  });
});
