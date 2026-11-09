// Claude Code adapter: native session logs → normalized model (ADR 0008, R-22).
//
// Log layout under a log root (default ~/.claude/projects):
//   <project>/<session>.jsonl                          main session
//   <project>/<session>/subagents/agent-<id>.jsonl     subagent of <session>
//   <project>/<session>/subagents/agent-<id>.meta.json the subagent's title (ADR 0016)
//
// Field semantics resolved here (pinned by test/core/adapters/claude-code.test.ts):
// - `input_tokens` excludes cached tokens, so it maps directly to `inputUncached`.
// - One API request is written as several `assistant` lines (one per content block) sharing a
//   `requestId`. They are collapsed into one Call. Input and cache fields repeat; `output_tokens`
//   can grow from line to line, so the largest value is the final one.
// - Forked or resumed sessions copy earlier lines, request IDs included, into a new file. A request
//   is counted once and belongs to the session that started first (ties: lowest session ID).
// - `model: "<synthetic>"` lines are placeholders written by the client, not model requests.
// - A `compact_boundary` system line marks a compaction. The summarization request behind it is not
//   logged, so it becomes a compaction Call whose token fields are all unknown (R-16).
// - `custom-title` lines carry the session's title; the last one in the file holds.
// - A subagent's `.meta.json` carries its `description`, the short task name it was started with, which is its title.
//   Nothing else of the file is kept (R-18).
//
// Session index files (ADR 0016), under a session index root (default: the Claude desktop app's
// claude-code-sessions folder): one `local_<id>.json` per desktop session. Only its desktop ID, its log session
// IDs (`cliSessionId`, `priorCliSessionIds`), its `title` and `spawnedFrom.sessionId` are kept; the rest of the
// file is discarded once parsed (R-18). A side session is linked to its starter only through these recorded IDs.

import type {
  AdapterOutput,
  Call,
  CapabilityTable,
  CompactionFigures,
  Diagnostic,
  Event,
  EventType,
  Session,
  SourceRef,
  TokenCount,
} from "../../model/index.js";
import type { LogFile } from "../../host/index.js";
import { compareByTimeThenSource, compareSources, compareStrings } from "../../order.js";
import { type Diagnose, isObject, parseTimestamp, push } from "../shared.js";

const HARNESS = "claudeCode";

/** Files this adapter reads, relative to a log root. */
export const CLAUDE_CODE_FILE_PATTERN = /^[^/]+\/(?:[^/]+\.jsonl|[^/]+\/subagents\/agent-[^/.]+\.(?:jsonl|meta\.json))$/;

const META_SUFFIX = ".meta.json";

/** Session index files this adapter reads, relative to a session index root (ADR 0016). */
export const CLAUDE_CODE_INDEX_FILE_PATTERN = /^(?:[^/]+\/)*local_[^/]+\.json$/;

export const claudeCodeCapabilities: CapabilityTable = {
  inputUncached: { kind: "recorded" },
  cacheRead: { kind: "recorded" },
  cacheWrite: { kind: "recorded" },
  output: { kind: "recorded" },
  reasoning: { kind: "recorded" },
};

/** Cache-write fields by the lifetime their name declares, in seconds. */
const CACHE_WRITE_TTL_FIELDS: readonly (readonly [field: string, ttlSeconds: string])[] = [
  ["ephemeral_5m_input_tokens", "300"],
  ["ephemeral_1h_input_tokens", "3600"],
];

const SYNTHETIC_MODEL = "<synthetic>";

interface FileSession {
  readonly nativeId: string;
  readonly parentNativeId: string | null;
}

/** The fields kept from one session index file (ADR 0016). */
interface IndexEntry {
  readonly desktopId: string;
  /** The current log session ID first, then earlier ones of the same desktop session. */
  readonly cliSessionIds: readonly string[];
  readonly title: string | null;
  readonly spawnedFromDesktopId: string | null;
  readonly source: SourceRef;
}

interface SessionAcc {
  readonly nativeId: string;
  readonly parentNativeId: string | null;
  projectPath: string | null;
  title: string | null;
  firstTimestamp: number | null;
  firstSource: SourceRef | null;
  readonly sources: SourceRef[];
}

interface Usage {
  readonly inputUncached: TokenCount;
  readonly cacheRead: TokenCount;
  readonly cacheWrite: TokenCount;
  readonly cacheWriteByTtlSeconds: Readonly<Record<string, number>> | null;
  readonly output: TokenCount;
  readonly reasoning: TokenCount;
}

interface RequestLine {
  readonly session: string;
  readonly timestamp: number;
  readonly model: string | null;
  readonly usage: Usage;
  readonly toolNames: readonly string[];
  readonly source: SourceRef;
}

interface MarkerLine {
  readonly session: string;
  readonly timestamp: number;
  readonly type: EventType | "compactionCall";
  readonly source: SourceRef;
  /** COMPACT-1: set on "compaction" markers. */
  readonly compaction?: CompactionFigures;
}

/** What one file contributes; plain JSON-safe data, read without looking at any other file (ADR 0014). */
export interface ClaudeCodeFileResult {
  readonly logRoot: string;
  readonly file: string;
  /** Null when the path does not match the layout. */
  readonly session: FileSession | null;
  readonly projectPath: string | null;
  readonly firstTimestamp: number | null;
  readonly firstSource: SourceRef | null;
  readonly requests: readonly (readonly [requestId: string, line: RequestLine])[];
  readonly markers: readonly (readonly [key: string, line: MarkerLine])[];
  /** The last `custom-title` of the file, or a subagent meta file's `description`. */
  readonly title: string | null;
  /** Set for a session index file, which has no session of its own. */
  readonly index: IndexEntry | null;
  readonly diagnostics: readonly Diagnostic[];
}

export function parseClaudeCode(files: readonly LogFile[]): AdapterOutput {
  return combineClaudeCode(files.map(readClaudeCodeFile));
}

/** Step 1 of ADR 0014: one file's records and diagnostics. */
export function readClaudeCodeFile(file: LogFile): ClaudeCodeFileResult {
  if (CLAUDE_CODE_INDEX_FILE_PATTERN.test(file.file)) return readIndexFile(file);
  if (file.file.endsWith(META_SUFFIX) && CLAUDE_CODE_FILE_PATTERN.test(file.file)) return readMetaFile(file);
  const requests: (readonly [string, RequestLine])[] = [];
  const markers: (readonly [string, MarkerLine])[] = [];
  const diagnostics: Diagnostic[] = [];
  const diagnose = (severity: Diagnostic["severity"], code: string, message: string, source: SourceRef) =>
    diagnostics.push({ harness: HARNESS, severity, code, message, sources: [source] });

  const fileSession = sessionOfPath(file.file);
  if (fileSession === null) {
    diagnose("warning", "unexpectedPath", "File path does not match the Claude Code log layout; skipped.", {
      logRoot: file.logRoot,
      file: file.file,
      line: 0,
    });
    return { logRoot: file.logRoot, file: file.file, session: null, projectPath: null, firstTimestamp: null, firstSource: null, requests, markers, title: null, index: null, diagnostics };
  }
  let projectPath: string | null = null;
  let title: string | null = null;
  let firstTimestamp: number | null = null;
  let firstSource: SourceRef | null = null;

  file.lines.forEach((text, index) => {
    if (text.trim() === "") return;
    const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: index + 1 };

    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      diagnose("warning", "invalidJson", "Line is not valid JSON; skipped.", source);
      return;
    }
    if (!isObject(entry)) {
      diagnose("warning", "unexpectedLine", "Line is not a JSON object; skipped.", source);
      return;
    }

    if (projectPath === null && typeof entry["cwd"] === "string") projectPath = entry["cwd"];

    const type = entry["type"];
    if (type === "custom-title" && typeof entry["customTitle"] === "string" && entry["customTitle"] !== "") title = entry["customTitle"];
    if (type !== "assistant" && type !== "user" && type !== "system") return;

    const timestamp = parseTimestamp(entry["timestamp"]);
    if (timestamp === null) {
      diagnose("warning", "invalidTimestamp", "Line has no valid ISO 8601 timestamp; skipped.", source);
      return;
    }
    if (firstTimestamp === null || timestamp < firstTimestamp) {
      firstTimestamp = timestamp;
      firstSource = source;
    }

    if (type === "assistant") {
      const line = readAssistant(entry, fileSession.nativeId, timestamp, source, diagnose);
      if (line !== null) requests.push([line.requestId, line.line]);
    } else if (type === "system") {
      const subtype = entry["subtype"];
      const uuid = typeof entry["uuid"] === "string" ? entry["uuid"] : null;
      if (uuid === null) return;
      if (subtype === "compact_boundary") {
        markers.push([`compaction:${uuid}`, { session: fileSession.nativeId, timestamp, type: "compaction", source, compaction: compactionFigures(entry["compactMetadata"]) }]);
        markers.push([`compactionCall:${uuid}`, { session: fileSession.nativeId, timestamp, type: "compactionCall", source }]);
      } else if (subtype === "api_error") {
        markers.push([`error:${uuid}`, { session: fileSession.nativeId, timestamp, type: "error", source }]);
      }
    } else if (isUserTurn(entry) && typeof entry["uuid"] === "string") {
      markers.push([`userTurn:${entry["uuid"]}`, { session: fileSession.nativeId, timestamp, type: "userTurn", source }]);
    }
  });

  return { logRoot: file.logRoot, file: file.file, session: fileSession, projectPath, firstTimestamp, firstSource, requests, markers, title, index: null, diagnostics };
}

/** One subagent meta file: only its `description` is kept, as the subagent's title (ADR 0016). */
function readMetaFile(file: LogFile): ClaudeCodeFileResult {
  const result = { logRoot: file.logRoot, file: file.file, session: sessionOfPath(file.file), projectPath: null, firstTimestamp: null, firstSource: null, requests: [], markers: [], index: null };
  let entry: unknown;
  try {
    entry = JSON.parse(file.lines.join("\n"));
  } catch {
    const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: 1 };
    return { ...result, title: null, diagnostics: [{ harness: HARNESS, severity: "warning", code: "invalidMetaFile", message: "Subagent meta file is not valid JSON; skipped.", sources: [source] }] };
  }
  const description = isObject(entry) ? entry["description"] : undefined;
  return { ...result, title: typeof description === "string" && description !== "" ? description : null, diagnostics: [] };
}

/** One desktop session index file: only the fields of ADR 0016 are kept. */
function readIndexFile(file: LogFile): ClaudeCodeFileResult {
  const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: 1 };
  const empty = { logRoot: file.logRoot, file: file.file, session: null, projectPath: null, firstTimestamp: null, firstSource: null, requests: [], markers: [], title: null };
  const fail = (code: string, message: string): ClaudeCodeFileResult => ({
    ...empty,
    index: null,
    diagnostics: [{ harness: HARNESS, severity: "warning", code, message, sources: [source] }],
  });
  let entry: unknown;
  try {
    entry = JSON.parse(file.lines.join("\n"));
  } catch {
    return fail("invalidIndexFile", "Session index file is not valid JSON; skipped.");
  }
  if (!isObject(entry) || typeof entry["sessionId"] !== "string" || typeof entry["cliSessionId"] !== "string") {
    return fail("unexpectedIndexFile", "Session index file has no sessionId or cliSessionId; skipped.");
  }
  const prior = Array.isArray(entry["priorCliSessionIds"]) ? entry["priorCliSessionIds"].filter((id): id is string => typeof id === "string") : [];
  const spawnedFrom = entry["spawnedFrom"];
  return {
    ...empty,
    index: {
      desktopId: entry["sessionId"],
      cliSessionIds: [entry["cliSessionId"], ...prior.filter((id) => id !== entry["cliSessionId"])],
      title: typeof entry["title"] === "string" && entry["title"] !== "" ? entry["title"] : null,
      spawnedFromDesktopId: isObject(spawnedFrom) && typeof spawnedFrom["sessionId"] === "string" ? spawnedFrom["sessionId"] : null,
      source,
    },
    diagnostics: [],
  };
}

/** Step 2 of ADR 0014: everything that spans files. The input order does not matter (R-10). */
export function combineClaudeCode(results: readonly ClaudeCodeFileResult[]): AdapterOutput {
  const sessions = new Map<string, SessionAcc>();
  const requests = new Map<string, RequestLine[]>();
  const markers = new Map<string, MarkerLine[]>();
  const diagnostics: Diagnostic[] = [];
  const diagnose = (severity: Diagnostic["severity"], code: string, message: string, source: SourceRef) =>
    diagnostics.push({ harness: HARNESS, severity, code, message, sources: [source] });

  const ordered = [...results].sort((a, b) => compareStrings(a.logRoot, b.logRoot) || compareStrings(a.file, b.file));
  const index: IndexEntry[] = [];
  for (const result of ordered) {
    diagnostics.push(...result.diagnostics);
    if (result.index !== null) index.push(result.index);
    if (result.session === null) continue;
    const session = sessionAcc(sessions, result.session);
    session.sources.push({ logRoot: result.logRoot, file: result.file, line: 1 });
    if (session.projectPath === null) session.projectPath = result.projectPath;
    if (session.title === null) session.title = result.title;
    if (result.firstTimestamp !== null && (session.firstTimestamp === null || result.firstTimestamp < session.firstTimestamp)) {
      session.firstTimestamp = result.firstTimestamp;
      session.firstSource = result.firstSource;
    }
    for (const [requestId, line] of result.requests) push(requests, requestId, line);
    for (const [key, line] of result.markers) push(markers, key, line);
  }

  const owner = (candidates: readonly string[]): string => pickOwner(candidates, sessions);

  const calls: Call[] = [];
  for (const [requestId, lines] of requests) {
    calls.push(buildCall(requestId, lines, owner, diagnose));
  }

  const events: Event[] = [];
  for (const [key, lines] of markers) {
    const first = lines[0] as MarkerLine;
    const sessionNativeId = owner(lines.map((line) => line.session));
    const own = lines.filter((line) => line.session === sessionNativeId);
    const timestamp = Math.min(...own.map((line) => line.timestamp));
    const sources = lines.map((line) => line.source).sort(compareSources);
    const nativeKey = key.slice(key.indexOf(":") + 1);
    if (first.type === "compactionCall") {
      calls.push({
        id: `${HARNESS}:compactionCall:${nativeKey}`,
        sessionId: sessionId(sessionNativeId),
        timestamp,
        model: null,
        kind: "compaction",
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        cacheWriteByTtlSeconds: null,
        toolNames: [],
        sources,
      });
    } else {
      events.push({
        id: `${HARNESS}:${first.type}:${nativeKey}`,
        sessionId: sessionId(sessionNativeId),
        timestamp,
        type: first.type,
        childSessionId: null,
        compaction: first.compaction ?? null,
        sources,
      });
    }
  }

  const links = sideSessionLinks(index, sessions, diagnose);
  const sessionList: Session[] = [];
  for (const acc of sessions.values()) {
    if (acc.firstTimestamp === null) continue;
    const link = links.get(acc.nativeId);
    sessionList.push({
      id: sessionId(acc.nativeId),
      harness: HARNESS,
      nativeId: acc.nativeId,
      parentSessionId: acc.parentNativeId === null ? null : sessionId(acc.parentNativeId),
      isSubagent: acc.parentNativeId !== null,
      spawnedBySessionId: link?.spawnedBy ?? null,
      title: link?.title ?? acc.title,
      projectPath: acc.projectPath,
      sources: acc.sources,
    });
    if (acc.parentNativeId !== null && acc.firstSource !== null) {
      events.push({
        id: `${HARNESS}:subagentSpawn:${acc.nativeId}`,
        sessionId: sessionId(acc.parentNativeId),
        timestamp: acc.firstTimestamp,
        type: "subagentSpawn",
        childSessionId: sessionId(acc.nativeId),
        compaction: null,
        sources: [acc.firstSource],
      });
    }
  }

  return {
    sessions: sessionList.sort((a, b) => compareStrings(a.id, b.id)),
    calls: calls.sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id)),
    events: events.sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id)),
    quotaSamples: [],
    diagnostics: diagnostics.sort(
      (a, b) => compareSources(a.sources[0] as SourceRef, b.sources[0] as SourceRef) || compareStrings(a.code, b.code),
    ),
  };
}

/**
 * ADR 0016: title and starter of each log session named in a session index file. An index file names its log
 * sessions by `cliSessionId` and `priorCliSessionIds`; its starter is the current log session of the desktop
 * session in `spawnedFrom.sessionId`. When two files name the same log session, the one whose current ID it is wins,
 * then the lowest desktop ID.
 */
function sideSessionLinks(
  index: readonly IndexEntry[],
  sessions: ReadonlyMap<string, SessionAcc>,
  diagnose: (severity: Diagnostic["severity"], code: string, message: string, source: SourceRef) => void,
): Map<string, { readonly title: string | null; readonly spawnedBy: string | null }> {
  const ordered = [...index].sort((a, b) => compareStrings(a.desktopId, b.desktopId));
  const byDesktopId = new Map(ordered.map((entry) => [entry.desktopId, entry]));
  const owner = new Map<string, IndexEntry>();
  for (const pass of [0, 1]) {
    for (const entry of ordered) {
      const ids = pass === 0 ? entry.cliSessionIds.slice(0, 1) : entry.cliSessionIds.slice(1);
      for (const id of ids) if (!owner.has(id)) owner.set(id, entry);
    }
  }
  const links = new Map<string, { title: string | null; spawnedBy: string | null }>();
  for (const [cliId, entry] of [...owner].sort(([a], [b]) => compareStrings(a, b))) {
    if (!sessions.has(cliId)) continue;
    let spawnedBy: string | null = null;
    if (entry.spawnedFromDesktopId !== null) {
      const starter = byDesktopId.get(entry.spawnedFromDesktopId)?.cliSessionIds[0];
      if (starter !== undefined && starter !== cliId && sessions.has(starter)) spawnedBy = sessionId(starter);
      else diagnose("warning", "unresolvedSideSessionLink", "The session that started this side session is not in the logs; no link is shown.", entry.source);
    }
    links.set(cliId, { title: entry.title, spawnedBy });
  }
  return links;
}

function sessionOfPath(path: string): FileSession | null {
  if (!CLAUDE_CODE_FILE_PATTERN.test(path)) return null;
  const parts = path.split("/");
  if (parts.length === 2) return { nativeId: stem(parts[1] as string), parentNativeId: null };
  const parent = parts[1] as string;
  return { nativeId: `${parent}/${stem(parts[3] as string)}`, parentNativeId: parent };
}

function stem(fileName: string): string {
  return fileName.slice(0, -(fileName.endsWith(META_SUFFIX) ? META_SUFFIX : ".jsonl").length);
}

function sessionId(nativeId: string): string {
  return `${HARNESS}:${nativeId}`;
}

function sessionAcc(sessions: Map<string, SessionAcc>, fileSession: FileSession): SessionAcc {
  let acc = sessions.get(fileSession.nativeId);
  if (acc === undefined) {
    acc = { ...fileSession, projectPath: null, title: null, firstTimestamp: null, firstSource: null, sources: [] };
    sessions.set(fileSession.nativeId, acc);
  }
  return acc;
}

/** The session that started first owns a record copied into several sessions (ties: lowest ID). */
function pickOwner(candidates: readonly string[], sessions: ReadonlyMap<string, SessionAcc>): string {
  const unique = [...new Set(candidates)];
  const start = (nativeId: string) => sessions.get(nativeId)?.firstTimestamp ?? Number.MAX_SAFE_INTEGER;
  unique.sort((a, b) => start(a) - start(b) || compareStrings(a, b));
  return unique[0] as string;
}

function readAssistant(
  entry: Record<string, unknown>,
  session: string,
  timestamp: number,
  source: SourceRef,
  diagnose: Diagnose,
): { readonly requestId: string; readonly line: RequestLine } | null {
  const message = entry["message"];
  if (!isObject(message)) {
    diagnose("warning", "missingMessage", "Assistant line has no message object; skipped.", source);
    return null;
  }
  const model = typeof message["model"] === "string" ? message["model"] : null;
  if (model === SYNTHETIC_MODEL) return null;

  const requestId = typeof entry["requestId"] === "string" && entry["requestId"] !== "" ? entry["requestId"] : null;
  if (requestId === null) {
    diagnose("warning", "missingRequestId", "Assistant line has no request ID; skipped.", source);
    return null;
  }
  const usage = message["usage"];
  if (!isObject(usage)) {
    diagnose("warning", "missingUsage", "Assistant line has no usage object; skipped.", source);
    return null;
  }

  const count = (value: unknown, field: string): TokenCount => {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    diagnose("warning", "invalidTokenCount", `Usage field ${field} is not a non-negative integer; treated as unknown.`, source);
    return null;
  };

  const creation = usage["cache_creation"];
  let byTtl: Record<string, number> | null = null;
  if (isObject(creation)) {
    byTtl = {};
    for (const [field, ttl] of CACHE_WRITE_TTL_FIELDS) {
      const value = count(creation[field], `cache_creation.${field}`);
      if (value !== null) byTtl[ttl] = value;
    }
  }
  const details = usage["output_tokens_details"];

  return {
    requestId,
    line: {
      session,
      timestamp,
      model,
      usage: {
        inputUncached: count(usage["input_tokens"], "input_tokens"),
        cacheRead: count(usage["cache_read_input_tokens"], "cache_read_input_tokens"),
        cacheWrite: count(usage["cache_creation_input_tokens"], "cache_creation_input_tokens"),
        cacheWriteByTtlSeconds: byTtl,
        output: count(usage["output_tokens"], "output_tokens"),
        reasoning: isObject(details) ? count(details["thinking_tokens"], "output_tokens_details.thinking_tokens") : null,
      },
      toolNames: toolNamesOf(message["content"]),
      source,
    },
  };
}

function buildCall(
  requestId: string,
  lines: readonly RequestLine[],
  owner: (candidates: readonly string[]) => string,
  diagnose: Diagnose,
): Call {
  const sessionNativeId = owner(lines.map((line) => line.session));
  const own = lines.filter((line) => line.session === sessionNativeId);
  const first = own[0] as RequestLine;

  // The line with the largest output is the final state of the request; ties keep the earliest line.
  let final = first;
  for (const line of own) {
    if ((line.usage.output ?? -1) > (final.usage.output ?? -1)) final = line;
  }
  const inputKey = (usage: Usage) =>
    JSON.stringify([usage.inputUncached, usage.cacheRead, usage.cacheWrite, usage.cacheWriteByTtlSeconds]);
  if (own.some((line) => inputKey(line.usage) !== inputKey(final.usage))) {
    diagnose("warning", "inconsistentUsage", "Lines of one request disagree on input or cache tokens; the final line is used.", final.source);
  }

  const toolNames: string[] = [];
  for (const line of own) {
    for (const name of line.toolNames) if (!toolNames.includes(name)) toolNames.push(name);
  }

  return {
    id: `${HARNESS}:${requestId}`,
    sessionId: sessionId(sessionNativeId),
    timestamp: Math.min(...own.map((line) => line.timestamp)),
    model: final.model,
    kind: "turn",
    ...final.usage,
    toolNames,
    sources: lines.map((line) => line.source).sort(compareSources),
  };
}

function toolNamesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (isObject(block) && block["type"] === "tool_use" && typeof block["name"] === "string") names.push(block["name"]);
  }
  return names;
}

/** COMPACT-1 (ADR 0017): `compactMetadata` of a `compact_boundary` line; a field that is missing or malformed is null. */
function compactionFigures(value: unknown): CompactionFigures {
  const meta = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const trigger = meta["trigger"];
  return { trigger: trigger === "manual" || trigger === "auto" ? trigger : null, preTokens: count(meta["preTokens"]), postTokens: count(meta["postTokens"]) };
}

/** A prompt the user sent: not a tool result, client metadata, compaction summary or subagent prompt. */
function isUserTurn(entry: Record<string, unknown>): boolean {
  if ("toolUseResult" in entry || entry["isMeta"] === true || entry["isCompactSummary"] === true) return false;
  if (entry["isSidechain"] === true) return false;
  if (entry["promptSource"] === "system") return false;
  const message = entry["message"];
  if (!isObject(message)) return false;
  const content = message["content"];
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.length > 0 && content.every((block) => isObject(block) && block["type"] !== "tool_result");
}
