// OpenCode SQLite adapter: normalized JSON-line stream -> normalized model (ADR 0008, ADR 0022, R-15–R-23).
//
// `src/core` stays host-independent and imports no `node:*` modules (ADR 0006).
// The host (`src/hosts/node/opencode-sqlite.ts`) reads `opencode.db` strictly read-only via a
// temporary copy and emits one JSON line per session, message, tool part, or host diagnostic.
//
// Field semantics resolved here (pinned by test/core/adapters/opencode.test.ts):
// - `tokens.input` is uncached input tokens (excludes `cache.read` and `cache.write`).
// - `tokens.reasoning` can exceed `tokens.output` in OpenCode and is kept as recorded when valid.
// - `compaction` messages emit both a `compaction` Event and a `compaction` Call (with recorded
//   tokens when present, or all `null` per R-16).

import type { LogFile } from "../../host/index.js";
import type {
  AdapterOutput,
  Call,
  CapabilityTable,
  Diagnostic,
  Event,
  Session,
  SourceRef,
  StepClass,
  TokenCount,
} from "../../model/index.js";
import { classifyShellCommand } from "../../model/step.js";
import { compareByTimeThenSource, compareSources, compareStrings } from "../../order.js";
import { isObject, push } from "../shared.js";

const HARNESS = "opencode";

/** Database file this adapter reads, relative to a log root. */
export const OPENCODE_FILE_PATTERN = /^opencode\.db$/;

export const opencodeCapabilities: CapabilityTable = {
  inputUncached: { kind: "recorded" },
  cacheRead: { kind: "recorded" },
  cacheWrite: { kind: "recorded" },
  output: { kind: "recorded" },
  reasoning: { kind: "recorded" },
};

const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"]);

type Fields = Record<string, unknown>;

interface ToolInput {
  readonly name: string;
  readonly command: string | null;
}

interface OpenCodeFileResult {
  readonly logRoot: string;
  readonly file: string;
  readonly sessions: readonly Session[];
  readonly calls: readonly Call[];
  readonly events: readonly Event[];
  readonly diagnostics: readonly Diagnostic[];
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const epochMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const tokenCount = (value: unknown): TokenCount =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function readTools(raw: unknown, extra: readonly ToolInput[] | undefined): {
  readonly toolNames: string[];
  readonly shellClasses: StepClass[];
} {
  const toolNames: string[] = [];
  const shellClasses: StepClass[] = [];
  const list = [
    ...(Array.isArray(raw) ? raw : []),
    ...(extra ?? []),
  ];
  for (const item of list) {
    if (!isObject(item)) continue;
    const name = str(item.name);
    if (name === null) continue;
    if (!toolNames.includes(name)) toolNames.push(name);
    if (SHELL_TOOLS.has(name)) {
      const cmd = typeof item.command === "string" ? item.command : null;
      shellClasses.push(cmd === null ? "other" : classifyShellCommand(cmd));
    }
  }
  return { toolNames, shellClasses };
}

function readTokens(
  raw: unknown,
  diagnose: (severity: Diagnostic["severity"], code: string, message: string) => void,
): {
  readonly inputUncached: TokenCount;
  readonly cacheRead: TokenCount;
  readonly cacheWrite: TokenCount;
  readonly output: TokenCount;
  readonly reasoning: TokenCount;
} {
  if (!isObject(raw)) {
    return { inputUncached: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null };
  }
  const cache = isObject(raw.cache) ? raw.cache : null;
  const fields: readonly [string, unknown][] = [
    ["input", raw.input],
    ["cache.read", cache?.read],
    ["cache.write", cache?.write],
    ["output", raw.output],
    ["reasoning", raw.reasoning],
  ];
  let bad = false;
  for (const [, v] of fields) {
    if (v !== undefined && v !== null && tokenCount(v) === null) bad = true;
  }
  if (bad) {
    diagnose("warning", "opencode_invalid_token_count", "Invalid token count in OpenCode message; treated as unknown.");
  }
  return {
    inputUncached: tokenCount(raw.input),
    cacheRead: tokenCount(cache?.read),
    cacheWrite: tokenCount(cache?.write),
    output: tokenCount(raw.output),
    reasoning: tokenCount(raw.reasoning),
  };
}

function modelId(raw: unknown): string | null {
  if (typeof raw === "string") return raw !== "" ? raw : null;
  if (!isObject(raw)) return null;
  return str(raw.id);
}

function messageTimestamp(row: Fields): number | null {
  const time = isObject(row.time) ? row.time : null;
  return epochMs(time?.completed) ?? epochMs(time?.created) ?? epochMs(row.timeCreated);
}

/** Step 1 (ADR 0014): parses one OpenCode SQLite JSON-line stream into file-local records. */
export function readOpenCodeFile(file: LogFile): OpenCodeFileResult {
  const sessions: Session[] = [];
  const calls: Call[] = [];
  const events: Event[] = [];
  const diagnostics: Diagnostic[] = [];
  const partsByMessage = new Map<string, ToolInput[]>();
  const messageRows: { readonly row: Fields; readonly source: SourceRef }[] = [];

  const diagnose = (severity: Diagnostic["severity"], code: string, message: string, source: SourceRef): void => {
    diagnostics.push({ harness: HARNESS, severity, code, message, sources: [source] });
  };

  file.lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (trimmed === "") return;
    const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: index + 1 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      diagnose("warning", "opencode_malformed_line", "Malformed JSON line in OpenCode stream.", source);
      return;
    }
    if (!isObject(parsed)) {
      diagnose("warning", "opencode_malformed_line", "Unexpected non-object record in OpenCode stream.", source);
      return;
    }
    const record = str(parsed.record);
    if (record === "diagnostic") {
      const severity = parsed.severity === "warning" ? "warning" : "error";
      const code = str(parsed.code) ?? "opencode_db_error";
      const message = str(parsed.message) ?? "Could not read OpenCode SQLite database.";
      diagnose(severity, code, message, source);
      return;
    }
    if (record === "session") {
      const nativeId = str(parsed.id);
      if (nativeId === null) {
        diagnose("warning", "opencode_invalid_session", "OpenCode session row is missing an ID.", source);
        return;
      }
      const parentNativeId = str(parsed.parentId);
      const sessionId = `${HARNESS}:${nativeId}`;
      const parentSessionId = parentNativeId === null ? null : `${HARNESS}:${parentNativeId}`;
      sessions.push({
        id: sessionId,
        harness: HARNESS,
        nativeId,
        parentSessionId,
        isSubagent: parentSessionId !== null,
        spawnedBySessionId: null,
        title: str(parsed.title),
        projectPath: str(parsed.projectPath),
        sources: [source],
      });
      const createdAt = epochMs(parsed.timeCreated);
      if (parentSessionId !== null && createdAt !== null) {
        events.push({
          id: `${HARNESS}:subagentSpawn:${nativeId}`,
          sessionId: parentSessionId,
          timestamp: createdAt,
          type: "subagentSpawn",
          childSessionId: sessionId,
          compaction: null,
          sources: [source],
        });
      }
      return;
    }
    if (record === "part") {
      const msgId = str(parsed.messageId);
      const tool = isObject(parsed.tool) ? parsed.tool : null;
      const name = tool === null ? null : str(tool.name);
      if (msgId !== null && name !== null) {
        push(partsByMessage, msgId, {
          name,
          command: typeof tool?.command === "string" ? tool.command : null,
        });
      }
      return;
    }
    if (record === "message") {
      messageRows.push({ row: parsed, source });
      return;
    }
    diagnose("warning", "opencode_unknown_record", "Unknown record kind in OpenCode stream.", source);
  });

  for (const { row, source } of messageRows) {
    const id = str(row.id);
    const nativeSessionId = str(row.sessionId);
    const type = str(row.type);
    const timestamp = messageTimestamp(row);
    if (id === null || nativeSessionId === null || type === null || timestamp === null) {
      diagnose("warning", "opencode_invalid_message", "OpenCode message row is missing required metadata.", source);
      continue;
    }
    const sessionId = `${HARNESS}:${nativeSessionId}`;
    if (type === "user") {
      events.push({
        id: `${HARNESS}:userTurn:${id}`,
        sessionId,
        timestamp,
        type: "userTurn",
        childSessionId: null,
        compaction: null,
        sources: [source],
      });
      continue;
    }
    if (type === "compaction") {
      events.push({
        id: `${HARNESS}:compaction:${id}`,
        sessionId,
        timestamp,
        type: "compaction",
        childSessionId: null,
        compaction: null,
        sources: [source],
      });
      const counts = readTokens(row.tokens, (sev, code, msg) => diagnose(sev, code, msg, source));
      calls.push({
        id: `${HARNESS}:compactionCall:${id}`,
        sessionId,
        timestamp,
        model: modelId(row.model),
        kind: "compaction",
        ...counts,
        cacheWriteByTtlSeconds: null,
        toolNames: [],
        shellClasses: [],
        sources: [source],
      });
      continue;
    }
    if (type === "assistant") {
      const counts = readTokens(row.tokens, (sev, code, msg) => diagnose(sev, code, msg, source));
      const { toolNames, shellClasses } = readTools(row.tools, partsByMessage.get(id));
      calls.push({
        id: `${HARNESS}:${id}`,
        sessionId,
        timestamp,
        model: modelId(row.model),
        kind: "turn",
        ...counts,
        cacheWriteByTtlSeconds: null,
        toolNames,
        shellClasses,
        sources: [source],
      });
    }
  }

  return { logRoot: file.logRoot, file: file.file, sessions, calls, events, diagnostics };
}

/** Step 2 (ADR 0014): combines per-file results in canonical order. */
export function combineOpenCode(results: readonly OpenCodeFileResult[]): AdapterOutput {
  const ordered = [...results].sort((a, b) => compareStrings(a.logRoot, b.logRoot) || compareStrings(a.file, b.file));
  const sessionsById = new Map<string, Session>();
  const callsById = new Map<string, Call>();
  const eventsById = new Map<string, Event>();
  const diagnostics: Diagnostic[] = [];

  for (const res of ordered) {
    for (const s of res.sessions) {
      if (!sessionsById.has(s.id)) sessionsById.set(s.id, s);
    }
    for (const c of res.calls) {
      if (!callsById.has(c.id)) callsById.set(c.id, c);
    }
    for (const e of res.events) {
      if (!eventsById.has(e.id)) eventsById.set(e.id, e);
    }
    diagnostics.push(...res.diagnostics);
  }

  return {
    sessions: [...sessionsById.values()].sort((a, b) => compareStrings(a.id, b.id)),
    calls: [...callsById.values()].sort(compareByTimeThenSource),
    events: [...eventsById.values()].sort(compareByTimeThenSource),
    quotaSamples: [],
    diagnostics: diagnostics.sort(
      (a, b) =>
        (a.sources[0] && b.sources[0] ? compareSources(a.sources[0], b.sources[0]) : 0) ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    ),
  };
}

/** Convenience entry point for tests: parses all OpenCode streams together. */
export function parseOpenCodeFiles(files: readonly LogFile[]): AdapterOutput {
  return combineOpenCode(files.map(readOpenCodeFile));
}
