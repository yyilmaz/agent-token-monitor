// Antigravity adapter: conversation transcripts → normalized model (ADR 0008, R-22).
//
// Log layout under a log root (default ~/.gemini/antigravity/brain):
//   <conversation>/.system_generated/logs/transcript.jsonl      one step per line
//   <conversation>/.system_generated/subagents/<child>.json     links subagent conversation <child>
//
// Field semantics resolved here (pinned by test/core/adapters/antigravity.test.ts):
// - Each `PLANNER_RESPONSE` step is one model request and becomes one Call, identified by its
//   `step_index`. `input_tokens` excludes cached tokens, so it maps directly to `inputUncached`.
// - The log has no cache-write category: prompt tokens not read from cache are counted in
//   `input_tokens`. `cacheWrite` is therefore 0 by the billing exception of ADR 0008 rule 2.
// - Neither the model name nor thinking tokens are logged: `model` and `reasoning` are unknown.
// - A `CHECKPOINT` step marks a compaction. Its summarization request is not logged, so it becomes a
//   compaction Call whose token fields are all unknown (R-16).
// - Subagents are separate conversations. The parent's `subagents/<child>.json` names the child and
//   the parent step at which it was spawned.

import type {
  AdapterOutput,
  Call,
  CapabilityTable,
  Diagnostic,
  Event,
  EventType,
  Session,
  SourceRef,
  StepClass,
  TokenCount,
} from "../../model/index.js";
import type { LogFile } from "../../host/index.js";
import { compareByTimeThenSource, compareSources, compareStrings } from "../../order.js";
import { classifyShellCommand } from "../../model/step.js";
import { type Diagnose, isObject, parseTimestamp } from "../shared.js";

const HARNESS = "antigravity";

const TRANSCRIPT = /^([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/;
const SUBAGENT_LINK = /^([^/]+)\/\.system_generated\/subagents\/[^/]+\.json$/;
const ANNOTATION = /^([^/]+)\.pbtxt$/;

/** Files this adapter reads, relative to a log root. */
export const ANTIGRAVITY_FILE_PATTERN =
  /^[^/]+\/\.system_generated\/(?:logs\/transcript\.jsonl|subagents\/[^/]+\.json)$/;

/** Session annotation files under `sessionIndexRoots.antigravity` (ADR 0016). */
export const ANTIGRAVITY_INDEX_FILE_PATTERN = /^[^/]+\.pbtxt$/;

export const antigravityCapabilities: CapabilityTable = {
  inputUncached: { kind: "recorded" },
  cacheRead: { kind: "recorded" },
  cacheWrite: {
    kind: "zeroByBilling",
    reason: "Antigravity logs no cache-write category; uncached prompt tokens are counted in input_tokens.",
  },
  output: { kind: "recorded" },
  reasoning: { kind: "notRecorded" },
};

/** Step types that become events, and the event they become. */
const EVENT_STEPS: Readonly<Record<string, EventType>> = {
  USER_INPUT: "userTurn",
  CHECKPOINT: "compaction",
  ERROR_MESSAGE: "error",
};

interface ConversationAcc {
  readonly nativeId: string;
  firstTimestamp: number | null;
  readonly sources: SourceRef[];
  /** step_index → timestamp and source of that step, for spawn events. */
  readonly steps: Map<number, StepInfo>;
}

interface SubagentLink {
  readonly parent: string;
  readonly child: string;
  readonly spawnStep: number | null;
  readonly source: SourceRef;
}

interface StepInfo {
  readonly timestamp: number;
  readonly source: SourceRef;
}

/** What one file contributes; plain JSON-safe data, read without looking at any other file (ADR 0014). */
export interface AntigravityFileResult {
  readonly logRoot: string;
  readonly file: string;
  /** Set for a transcript. */
  readonly conversation: {
    readonly nativeId: string;
    readonly firstTimestamp: number | null;
    /** First timestamp and source of each step_index, for spawn events. */
    readonly steps: readonly (readonly [stepIndex: number, step: StepInfo])[];
  } | null;
  /** Set for a valid subagent link file. */
  readonly link: SubagentLink | null;
  /** Set for a `.pbtxt` annotation file with a non-empty `title` (ADR 0016). */
  readonly annotation: { readonly nativeId: string; readonly title: string } | null;
  readonly calls: readonly Call[];
  readonly events: readonly Event[];
  readonly diagnostics: readonly Diagnostic[];
}

export function parseAntigravity(files: readonly LogFile[]): AdapterOutput {
  return combineAntigravity(files.map(readAntigravityFile));
}

/** Step 1 of ADR 0014: one file's records and diagnostics. */
export function readAntigravityFile(file: LogFile): AntigravityFileResult {
  const calls: Call[] = [];
  const events: Event[] = [];
  const diagnostics: Diagnostic[] = [];
  const diagnose: Diagnose = (severity, code, message, source) =>
    diagnostics.push({ harness: HARNESS, severity, code, message, sources: [source] });
  const base = { logRoot: file.logRoot, file: file.file, conversation: null, link: null, annotation: null, calls, events, diagnostics };

  const transcript = TRANSCRIPT.exec(file.file);
  const link = SUBAGENT_LINK.exec(file.file);
  const annotation = ANNOTATION.exec(file.file);
  if (transcript !== null) {
    const conversation: ConversationAcc = { nativeId: transcript[1] as string, firstTimestamp: null, sources: [], steps: new Map() };
    readTranscript(file, conversation, calls, events, diagnose);
    return { ...base, conversation: { nativeId: conversation.nativeId, firstTimestamp: conversation.firstTimestamp, steps: [...conversation.steps] } };
  }
  if (link !== null) return { ...base, link: readSubagentLink(file, link[1] as string, diagnose) };
  if (annotation !== null) return { ...base, annotation: readAnnotation(file, annotation[1] as string) };
  diagnose("warning", "unexpectedPath", "File path does not match the Antigravity log layout; skipped.", {
    logRoot: file.logRoot,
    file: file.file,
    line: 0,
  });
  return base;
}

/** Step 2 of ADR 0014: everything that spans files. The input order does not matter (R-10). */
export function combineAntigravity(results: readonly AntigravityFileResult[]): AdapterOutput {
  const conversations = new Map<string, ConversationAcc>();
  const links: SubagentLink[] = [];
  const titles = new Map<string, string>();
  const calls: Call[] = [];
  const events: Event[] = [];
  const diagnostics: Diagnostic[] = [];
  const diagnose: Diagnose = (severity, code, message, source) =>
    diagnostics.push({ harness: HARNESS, severity, code, message, sources: [source] });

  const ordered = [...results].sort((a, b) => compareStrings(a.logRoot, b.logRoot) || compareStrings(a.file, b.file));
  for (const result of ordered) {
    calls.push(...result.calls);
    events.push(...result.events);
    diagnostics.push(...result.diagnostics);
    if (result.link !== null) links.push(result.link);
    if (result.annotation !== null) titles.set(result.annotation.nativeId, result.annotation.title);
    if (result.conversation === null) continue;
    const conversation = conversationAcc(conversations, result.conversation.nativeId);
    conversation.sources.push({ logRoot: result.logRoot, file: result.file, line: 1 });
    const first = result.conversation.firstTimestamp;
    if (first !== null && (conversation.firstTimestamp === null || first < conversation.firstTimestamp)) conversation.firstTimestamp = first;
    for (const [stepIndex, step] of result.conversation.steps) if (!conversation.steps.has(stepIndex)) conversation.steps.set(stepIndex, step);
  }

  // A child linked by several parents keeps the lowest parent ID, so the result does not depend on file order.
  const parentOf = new Map<string, SubagentLink>();
  for (const link of [...links].sort((a, b) => compareStrings(a.parent, b.parent) || compareSources(a.source, b.source))) {
    const known = parentOf.get(link.child);
    if (known === undefined) parentOf.set(link.child, link);
    else if (known.parent !== link.parent) {
      diagnose("warning", "conflictingParent", "Subagent conversation is linked by more than one parent; the lowest parent ID is used.", link.source);
    }
  }

  const sessions: Session[] = [];
  for (const conversation of conversations.values()) {
    if (conversation.firstTimestamp === null) continue;
    const link = parentOf.get(conversation.nativeId);
    sessions.push({
      id: sessionId(conversation.nativeId),
      harness: HARNESS,
      nativeId: conversation.nativeId,
      parentSessionId: link === undefined ? null : sessionId(link.parent),
      isSubagent: link !== undefined,
      spawnedBySessionId: null,
      title: titles.get(conversation.nativeId) ?? null,
      projectPath: null,
      sources: link === undefined ? conversation.sources : [...conversation.sources, link.source].sort(compareSources),
    });
    if (link === undefined) continue;
    const spawn = link.spawnStep === null ? undefined : conversations.get(link.parent)?.steps.get(link.spawnStep);
    if (spawn === undefined) {
      diagnose("warning", "missingSpawnStep", "The parent step that spawned this subagent was not found; no spawn event is emitted.", link.source);
      continue;
    }
    events.push({
      id: `${HARNESS}:subagentSpawn:${conversation.nativeId}`,
      sessionId: sessionId(link.parent),
      timestamp: spawn.timestamp,
      type: "subagentSpawn",
      childSessionId: sessionId(conversation.nativeId),
      compaction: null,
      sources: [spawn.source, link.source].sort(compareSources),
    });
  }

  return {
    sessions: sessions.sort((a, b) => compareStrings(a.id, b.id)),
    calls: calls.sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id)),
    events: events.sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id)),
    quotaSamples: [],
    diagnostics: diagnostics.sort(
      (a, b) => compareSources(a.sources[0] as SourceRef, b.sources[0] as SourceRef) || compareStrings(a.code, b.code),
    ),
  };
}

function readTranscript(
  file: LogFile,
  conversation: ConversationAcc,
  calls: Call[],
  events: Event[],
  diagnose: Diagnose,
): void {
  const session = sessionId(conversation.nativeId);
  const seen = new Set<string>();

  file.lines.forEach((text, index) => {
    if (text.trim() === "") return;
    const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: index + 1 };

    let step: unknown;
    try {
      step = JSON.parse(text);
    } catch {
      diagnose("warning", "invalidJson", "Line is not valid JSON; skipped.", source);
      return;
    }
    if (!isObject(step)) {
      diagnose("warning", "unexpectedLine", "Line is not a JSON object; skipped.", source);
      return;
    }

    const type = step["type"];
    const eventType = typeof type === "string" ? EVENT_STEPS[type] : undefined;
    const isCall = type === "PLANNER_RESPONSE";
    const timestamp = parseTimestamp(step["created_at"]);
    const stepIndex = step["step_index"];
    const validStep = typeof stepIndex === "number" && Number.isSafeInteger(stepIndex) && stepIndex >= 0;

    if (timestamp !== null) {
      if (conversation.firstTimestamp === null || timestamp < conversation.firstTimestamp) {
        conversation.firstTimestamp = timestamp;
      }
      if (validStep && !conversation.steps.has(stepIndex)) conversation.steps.set(stepIndex, { timestamp, source });
    }
    if (!isCall && eventType === undefined) return;

    if (timestamp === null) {
      diagnose("warning", "invalidTimestamp", "Step has no valid ISO 8601 timestamp; skipped.", source);
      return;
    }
    if (!validStep) {
      diagnose("warning", "invalidStepIndex", "Step has no valid step index; skipped.", source);
      return;
    }
    const key = `${isCall ? "call" : eventType}:${stepIndex}`;
    if (seen.has(key)) {
      diagnose("warning", "duplicateStep", "Step index already used by an earlier step of the same type; skipped.", source);
      return;
    }
    seen.add(key);
    const nativeKey = `${conversation.nativeId}:${stepIndex}`;

    if (isCall) {
      calls.push(readPlannerResponse(step, nativeKey, session, timestamp, source, diagnose));
      return;
    }
    if (eventType === "compaction") calls.push(compactionCall(nativeKey, session, timestamp, source));
    events.push({
      id: `${HARNESS}:${eventType}:${nativeKey}`,
      sessionId: session,
      timestamp,
      type: eventType as EventType,
      childSessionId: null,
      // Antigravity's CHECKPOINT step logs no token counts (COMPACT-1).
      compaction: null,
      sources: [source],
    });
  });
}

function readPlannerResponse(
  step: Record<string, unknown>,
  nativeKey: string,
  session: string,
  timestamp: number,
  source: SourceRef,
  diagnose: Diagnose,
): Call {
  const count = (field: string): TokenCount => {
    const value = step[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    diagnose("warning", "invalidTokenCount", `Field ${field} is not a non-negative integer; treated as unknown.`, source);
    return null;
  };
  const inputUncached = count("input_tokens");
  const cacheRead = count("cache_read_tokens");
  const output = count("output_tokens");
  const hasUsage = inputUncached !== null || cacheRead !== null || output !== null;
  if (!hasUsage) {
    diagnose("warning", "missingUsage", "Planner step has no token counts; its tokens are unknown.", source);
  }
  return {
    id: `${HARNESS}:${nativeKey}`,
    sessionId: session,
    timestamp,
    model: null,
    kind: "turn",
    inputUncached,
    cacheRead,
    // ADR 0008 rule 2 exception: no cache-write category. Unknown when the step logs no usage at all.
    cacheWrite: hasUsage ? 0 : null,
    output,
    reasoning: null,
    cacheWriteByTtlSeconds: null,
    toolNames: toolNamesOf(step["tool_calls"]),
    shellClasses: shellClassesOf(step["tool_calls"]),
    sources: [source],
  };
}

function compactionCall(nativeKey: string, session: string, timestamp: number, source: SourceRef): Call {
  return {
    id: `${HARNESS}:compactionCall:${nativeKey}`,
    sessionId: session,
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
    shellClasses: [],
    sources: [source],
  };
}

function readSubagentLink(file: LogFile, parent: string, diagnose: Diagnose): SubagentLink | null {
  const source: SourceRef = { logRoot: file.logRoot, file: file.file, line: 1 };
  let link: unknown;
  try {
    link = JSON.parse(file.lines.join("\n"));
  } catch {
    diagnose("warning", "invalidJson", "Subagent file is not valid JSON; skipped.", source);
    return null;
  }
  const child = isObject(link) ? link["conversationId"] : undefined;
  if (!isObject(link) || typeof child !== "string" || child === "" || child.includes("/") || child === parent) {
    diagnose("warning", "invalidSubagentLink", "Subagent file has no valid conversation ID; skipped.", source);
    return null;
  }
  const spawn = link["spawnStepIndex"];
  const spawnStep = typeof spawn === "number" && Number.isSafeInteger(spawn) && spawn >= 0 ? spawn : null;
  return { parent, child, spawnStep, source };
}

function readAnnotation(file: LogFile, nativeId: string): { readonly nativeId: string; readonly title: string } | null {
  const text = file.lines.join("\n");
  const match = /\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (match === null) return null;
  const title = (match[1] as string)
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .trim();
  return title === "" ? null : { nativeId, title };
}

function toolNamesOf(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const call of toolCalls) {
    if (isObject(call) && typeof call["name"] === "string" && !names.includes(call["name"])) names.push(call["name"]);
  }
  return names;
}

/**
 * STEP-1 (ADR 0017): classify each `run_command` call from `args.CommandLine`; the command is discarded (R-18).
 * The log stores the command as a JSON-encoded string, so a value in quotes is decoded first.
 */
function shellClassesOf(toolCalls: unknown): StepClass[] {
  if (!Array.isArray(toolCalls)) return [];
  const classes: StepClass[] = [];
  for (const call of toolCalls) {
    if (!isObject(call) || call["name"] !== "run_command") continue;
    const args = call["args"];
    const raw = isObject(args) && typeof args["CommandLine"] === "string" ? args["CommandLine"] : null;
    classes.push(raw === null ? "other" : classifyShellCommand(decodeQuoted(raw)));
  }
  return classes;
}

function decodeQuoted(value: string): string {
  if (!value.startsWith("\"")) return value;
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded === "string") return decoded;
  } catch {
    // Not a complete JSON string: classify what follows the opening quote.
  }
  return value.slice(1);
}

function sessionId(nativeId: string): string {
  return `${HARNESS}:${nativeId}`;
}

function conversationAcc(conversations: Map<string, ConversationAcc>, nativeId: string): ConversationAcc {
  let acc = conversations.get(nativeId);
  if (acc === undefined) {
    acc = { nativeId, firstTimestamp: null, sources: [], steps: new Map() };
    conversations.set(nativeId, acc);
  }
  return acc;
}
