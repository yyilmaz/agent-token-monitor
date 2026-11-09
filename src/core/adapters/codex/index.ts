// Codex rollout normalization (ADR 0018, R-15–R-23).
import type { LogFile } from "../../host/index.js";
import type { AdapterOutput, Call, CapabilityTable, Diagnostic, Event, QuotaSample, Session, SourceRef } from "../../model/index.js";
import { compareByTimeThenSource, compareSources, compareStrings } from "../../order.js";
import { isObject, parseTimestamp, push } from "../shared.js";

export const CODEX_FILE_PATTERN = /(^|\/)rollout-[^/]*\.jsonl$/;

export const codexCapabilities: CapabilityTable = {
  inputUncached: { kind: "derived", rule: "COD-3" },
  cacheRead: { kind: "recorded" },
  cacheWrite: { kind: "recorded" },
  output: { kind: "recorded" },
  reasoning: { kind: "recorded" },
};

const HARNESS = "codex";
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1000;
const TOKEN_KEYS = [
  "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens",
] as const;

type Fields = Record<string, unknown>;
type Counts = Pick<Call, "inputUncached" | "cacheRead" | "cacheWrite" | "output" | "reasoning">;

interface Request extends Counts {
  readonly responseId: string | null;
  cumulativeTotal: number | null;
  readonly timestamp: number;
  readonly model: string | null;
  readonly sources: SourceRef[];
}

interface CodexFileResult {
  readonly fileSource: SourceRef;
  readonly session: Session | null;
  readonly requests: readonly Request[];
  readonly events: readonly Event[];
  readonly quotaSamples: readonly QuotaSample[];
  readonly diagnostics: readonly Diagnostic[];
}

const object = (value: unknown): Fields | null => isObject(value) ? value : null;
const string = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const total = (value: unknown): number | null => count(object(value)?.total_tokens);
const scale = (value: unknown, factor: number): number | null => {
  const units = count(value);
  return units === null ? null : count(units * factor);
};

function readCounts(usage: Fields): Counts {
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens);
  const output = count(usage.output_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  const cacheRead = input !== null && cached !== null && cached > input ? null : cached;
  return {
    inputUncached: input !== null && cacheRead !== null ? input - cacheRead : null,
    cacheRead,
    cacheWrite: count(usage.cache_write_input_tokens),
    output,
    reasoning: output !== null && reasoning !== null && reasoning > output ? null : reasoning,
  };
}

function repeatsUsage(request: Request, requestUsage: Fields, cumulativeTotal: number | null, snapshotUsage: Fields): boolean {
  return (request.cumulativeTotal === null || cumulativeTotal === null || request.cumulativeTotal === cumulativeTotal)
    && TOKEN_KEYS.every((key) => count(requestUsage[key]) === count(snapshotUsage[key]));
}

function readQuota(limits: Fields, timestamp: number, source: SourceRef): QuotaSample[] {
  const samples: QuotaSample[] = [];
  for (const window of ["primary", "secondary"]) {
    const data = object(limits[window]);
    if (data === null) continue;
    const percent = data.used_percent;
    samples.push({
      harness: HARNESS,
      timestamp,
      window,
      windowSeconds: scale(data.window_minutes, SECONDS_PER_MINUTE),
      usedPercent: typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : null,
      resetsAt: scale(data.resets_at, MILLIS_PER_SECOND),
      sources: [source],
    });
  }
  return samples;
}

/** ADR 0014 step 1. Discard transcript content as each line is read (R-18). */
export function readCodexFile(file: LogFile): CodexFileResult {
  const fileSource = { logRoot: file.logRoot, file: file.file, line: 1 };
  let session: Session | null = null;
  let model: string | null = null;
  let previousTotal = 0;
  let pending: { request: Request; usage: Fields } | null = null;
  const requests: Request[] = [];
  const markers: Omit<Event, "id" | "sessionId">[] = [];
  const quotaSamples: QuotaSample[] = [];
  const diagnostics: Diagnostic[] = [];
  const warn = (code: string, message: string, source: SourceRef) =>
    diagnostics.push({ harness: HARNESS, severity: "warning", code, message, sources: [source] });

  for (const [index, line] of file.lines.entries()) {
    if (line.trim() === "") continue;
    const source = { ...fileSource, line: index + 1 };
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      warn("invalidJson", "Line is not valid JSON; skipped.", source);
      continue;
    }
    const payload = isObject(entry) ? object(entry.payload) : null;
    if (!isObject(entry) || typeof entry.type !== "string" || payload === null) {
      warn("unexpectedLine", "Line is not a Codex rollout record; skipped.", source);
      continue;
    }

    if (entry.type === "session_meta" && session === null) {
      const nativeId = string(payload.id);
      if (nativeId === null) continue;
      const subagent = object(object(payload.source)?.subagent);
      const spawn = object(subagent?.thread_spawn);
      const parent = string(payload.parent_thread_id) ?? string(spawn?.parent_thread_id);
      session = {
        id: `${HARNESS}:${nativeId}`,
        nativeId,
        harness: HARNESS,
        parentSessionId: parent === null ? null : `${HARNESS}:${parent}`,
        isSubagent: parent !== null || subagent !== null || string(payload.agent_path) !== null,
        spawnedBySessionId: null,
        title: null,
        projectPath: string(payload.cwd),
        sources: [source],
      };
      continue;
    }
    if (entry.type === "turn_context") {
      model = string(payload.model);
      pending = null;
      continue;
    }

    const tokenCount = entry.type === "event_msg" && payload.type === "token_count";
    const requestRecord = entry.type === "token_usage_record";
    const marker = entry.type === "compacted" ? "compaction"
      : entry.type === "event_msg" && payload.type === "user_message" ? "userTurn" : null;
    if (!tokenCount && !requestRecord && marker === null) continue;
    const timestamp = parseTimestamp(entry.timestamp);
    if (timestamp === null) {
      warn("invalidTimestamp", "Line has no valid ISO 8601 timestamp; skipped.", source);
      continue;
    }

    if (marker !== null) {
      markers.push({ timestamp, type: marker, childSessionId: null, compaction: null, sources: [source] });
      continue;
    }
    if (requestRecord) {
      const usage = object(payload.usage);
      const responseId = string(payload.response_id);
      if (usage === null || responseId === null || !TOKEN_KEYS.some((key) => count(usage[key]) !== null)) {
        warn("unsupportedUsage", "Codex request has no valid usage or response ID; skipped.", source);
        pending = null;
        continue;
      }
      const cumulativeTotal = total(payload.thread_token_usage);
      const request = { ...readCounts(usage), responseId, cumulativeTotal, timestamp, model, sources: [source] };
      requests.push(request);
      pending = { request, usage };
      if (cumulativeTotal !== null) previousTotal = Math.max(previousTotal, cumulativeTotal);
      continue;
    }

    const limits = object(payload.rate_limits);
    if (limits !== null) quotaSamples.push(...readQuota(limits, timestamp, source));
    if (payload.info === null || (payload.info === undefined && limits !== null)) continue;
    const info = object(payload.info);
    const usage = object(info?.last_token_usage);
    const cumulativeTotal = total(info?.total_token_usage);
    if (usage === null || !TOKEN_KEYS.some((key) => count(usage[key]) !== null)) {
      warn("unsupportedUsage", "Codex token snapshot has no valid last usage; skipped.", source);
      continue;
    }
    if (pending !== null && repeatsUsage(pending.request, pending.usage, cumulativeTotal, usage)) {
      pending.request.sources.push(source);
      pending.request.cumulativeTotal ??= cumulativeTotal;
    } else if (cumulativeTotal !== null && cumulativeTotal > previousTotal) {
      requests.push({ ...readCounts(usage), responseId: null, cumulativeTotal, timestamp, model, sources: [source] });
    } else if (cumulativeTotal === null) {
      warn("unsupportedUsage", "Codex token snapshot has no valid cumulative total; skipped.", source);
    }
    pending = null;
    if (cumulativeTotal !== null) previousTotal = Math.max(previousTotal, cumulativeTotal);
  }

  if (session === null) warn("missingSession", "Codex rollout has no valid session metadata; session records skipped.", fileSource);
  const events = session === null ? [] : markers.map((event, index): Event => ({
    ...event,
    id: `${session.id}:event:${event.type}:${event.timestamp}:${index}`,
    sessionId: session.id,
  }));
  return { fileSource, session, requests, events, quotaSamples, diagnostics };
}

/** ADR 0014 step 2. Resolve repeated records across roots in canonical source order. */
export function combineCodex(results: readonly CodexFileResult[]): AdapterOutput {
  const ordered = [...results].sort((a, b) => compareSources(a.fileSource, b.fileSource));
  const sessions = new Map<string, Session>();
  const requests = new Map<string, Request[]>();
  const responsesByTotal = new Map<string, string>();
  const events = new Map<string, Event>();
  const quotaSamples: QuotaSample[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const result of ordered) {
    diagnostics.push(...result.diagnostics);
    quotaSamples.push(...result.quotaSamples);
    const session = result.session;
    if (session === null) continue;
    const existing = sessions.get(session.id);
    sessions.set(session.id, existing === undefined ? session : { ...existing, sources: [...existing.sources, ...session.sources] });
    for (const event of result.events) {
      const existing = events.get(event.id);
      events.set(event.id, existing === undefined ? event : { ...existing, sources: [...existing.sources, ...event.sources] });
    }
    for (const request of result.requests) {
      push(requests, session.id, request);
      if (request.responseId !== null && request.cumulativeTotal !== null) {
        responsesByTotal.set(`${session.id}:total:${request.cumulativeTotal}`, request.responseId);
      }
    }
  }

  const calls = new Map<string, { call: Call; explicit: boolean }>();
  for (const [sessionId, sessionRequests] of requests) {
    for (const request of sessionRequests) {
      const legacyId = `${sessionId}:total:${request.cumulativeTotal}`;
      const responseId = request.responseId ?? responsesByTotal.get(legacyId);
      const id = responseId === undefined ? legacyId : `${sessionId}:response:${responseId}`;
      const existing = calls.get(id);
      const explicit = request.responseId !== null;
      const { responseId: _response, cumulativeTotal: _total, ...fields } = request;
      const call: Call = { ...fields, id, sessionId, kind: "turn", cacheWriteByTtlSeconds: null, toolNames: [] };
      if (existing === undefined) {
        calls.set(id, { call, explicit });
      } else {
        const preferred = explicit && !existing.explicit ? call : existing.call;
        const sources = [...existing.call.sources, ...request.sources].sort(compareSources);
        calls.set(id, { call: { ...preferred, sources }, explicit: explicit || existing.explicit });
      }
    }
  }

  return {
    sessions: [...sessions.values()].sort((a, b) => compareStrings(a.id, b.id)),
    calls: [...calls.values()].map(({ call }) => call).sort(compareByTimeThenSource),
    events: [...events.values()].sort(compareByTimeThenSource),
    quotaSamples: quotaSamples.sort(compareByTimeThenSource),
    diagnostics,
  };
}

export const parseCodex = (files: readonly LogFile[]): AdapterOutput => combineCodex(files.map(readCodexFile));
