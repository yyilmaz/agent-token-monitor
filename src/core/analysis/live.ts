// Open sessions and their cache status (ADR 0013 rule LIVE-1, R-33 view 1), and the tree they are shown in
// (ADR 0016 rule TREE-1). The "as of" time is an input.

import type { Config } from "../config/config.js";
import type { Call, EpochMillis, HarnessId, Session } from "../model/index.js";
import { compareStrings } from "../order.js";
import { type CacheAnalysis, type CallCacheResult, loggedLifetime, type ModelSource, type ReferenceSource } from "./cache.js";

export type CacheStatus = "missedOnLastCall" | "warm" | "probablyCold";

export interface OpenSession {
  readonly rule: "LIVE-1";
  readonly sessionId: string;
  readonly harness: HarnessId;
  readonly parentSessionId: string | null;
  readonly isSubagent: boolean;
  readonly spawnedBySessionId: string | null;
  readonly title: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  readonly lastCallId: string;
  readonly lastCallAt: EpochMillis;
  readonly secondsSinceLastCall: number;
  /** Context size of the last call; null when unknown. */
  readonly contextTokens: number | null;
  readonly cacheStatus: CacheStatus;
  readonly referenceLifetimeSeconds: number;
  readonly referenceSource: ReferenceSource;
}

export function openSessions(
  input: { readonly sessions: readonly Session[]; readonly calls: readonly Call[] },
  cache: CacheAnalysis,
  settings: Pick<Config, "liveView" | "cache">,
  asOf: EpochMillis,
): OpenSession[] {
  const callById = new Map(input.calls.map((c) => [c.id, c]));
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  // The observed median is only used without a declared lifetime, so only groups with none are relevant (LIFE-1).
  const median = new Map(cache.lifetimes.filter((g) => g.declaredLifetimeSeconds === null).map((g) => [`${g.harness}\u0000${g.model}\u0000${g.modelSource}`, g.medianSeconds]));

  // cache.calls are in canonical order, so the last result per session is its last turn call.
  const last = new Map<string, CallCacheResult>();
  const lastWritten = new Map<string, number>();
  for (const result of cache.calls) {
    last.set(result.sessionId, result);
    const logged = loggedLifetime(callById.get(result.callId) as Call);
    if (logged !== null) lastWritten.set(result.sessionId, logged);
  }

  const open: OpenSession[] = [];
  for (const [sessionId, result] of last) {
    const call = callById.get(result.callId) as Call;
    const session = sessionById.get(sessionId) as Session;
    const secondsSinceLastCall = (asOf - call.timestamp) / 1000;
    if (secondsSinceLastCall > settings.liveView.openWithinSeconds) continue;

    // The lifetime of the cache the last call left: DECL-1, else observed median, else configured (as CAUSE-1).
    const declared = lastWritten.get(sessionId) ?? result.declaredLifetimeSeconds;
    const observed = result.model === null ? null : (median.get(`${result.harness}\u0000${result.model}\u0000${result.modelSource}`) ?? null);
    const [referenceLifetimeSeconds, referenceSource]: [number, ReferenceSource] =
      declared !== null
        ? [declared, "declared"]
        : observed !== null
          ? [observed, "observed"]
          : [settings.cache.referenceLifetimeSeconds[result.harness], "configured"];

    const context =
      call.inputUncached === null || call.cacheRead === null || call.cacheWrite === null ? null : call.inputUncached + call.cacheRead + call.cacheWrite;
    open.push({
      rule: "LIVE-1",
      sessionId,
      harness: result.harness,
      parentSessionId: session.parentSessionId,
      isSubagent: session.isSubagent,
      spawnedBySessionId: session.spawnedBySessionId,
      title: session.title,
      project: session.projectPath,
      model: result.model,
      modelSource: result.modelSource,
      lastCallId: call.id,
      lastCallAt: call.timestamp,
      secondsSinceLastCall,
      contextTokens: context,
      cacheStatus: result.cacheLoss ? "missedOnLastCall" : secondsSinceLastCall <= referenceLifetimeSeconds ? "warm" : "probablyCold",
      referenceLifetimeSeconds,
      referenceSource,
    });
  }
  return open.sort((a, b) => b.lastCallAt - a.lastCallAt || compareStrings(a.sessionId, b.sessionId));
}

export interface TreeRow {
  readonly rule: "TREE-1";
  readonly sessionId: string;
  readonly depth: number;
  readonly relation: "root" | "sideSession" | "subagent";
  readonly harness: HarnessId;
  readonly title: string | null;
  readonly project: string | null;
  /** The open session; null for a session shown only because one of its descendants is open ("waiting"). */
  readonly open: OpenSession | null;
}

/**
 * TREE-1: open sessions as a tree. A session's children are its side sessions and subagents; a session that is not
 * open appears, as "waiting", when one of its descendants is open. Siblings and roots are ordered by the newest last
 * call in their subtree, newest first, then by session ID.
 */
export function sessionTree(sessions: readonly Session[], open: readonly OpenSession[]): TreeRow[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const openById = new Map(open.map((s) => [s.sessionId, s]));
  const parentOf = (s: Session) => s.parentSessionId ?? s.spawnedBySessionId;

  // The open sessions and every ancestor; a cycle in the recorded links stops at the first repeat.
  const shown = new Set<string>();
  for (const s of open) {
    let id: string | null = s.sessionId;
    while (id !== null && byId.has(id) && !shown.has(id)) {
      shown.add(id);
      id = parentOf(byId.get(id) as Session);
    }
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of shown) {
    const parent = parentOf(byId.get(id) as Session);
    if (parent !== null && shown.has(parent)) children.set(parent, [...(children.get(parent) ?? []), id]);
    else roots.push(id);
  }

  const newest = new Map<string, number>();
  const newestOf = (id: string, path: Set<string>): number => {
    const known = newest.get(id);
    if (known !== undefined) return known;
    path.add(id);
    let value = openById.get(id)?.lastCallAt ?? Number.NEGATIVE_INFINITY;
    for (const child of children.get(id) ?? []) if (!path.has(child)) value = Math.max(value, newestOf(child, path));
    newest.set(id, value);
    return value;
  };
  const order = (ids: string[]) => ids.sort((a, b) => newestOf(b, new Set()) - newestOf(a, new Set()) || compareStrings(a, b));

  const rows: TreeRow[] = [];
  const visit = (id: string, depth: number, path: Set<string>) => {
    if (path.has(id)) return;
    path.add(id);
    const s = byId.get(id) as Session;
    rows.push({
      rule: "TREE-1",
      sessionId: id,
      depth,
      relation: depth === 0 ? "root" : s.isSubagent ? "subagent" : "sideSession",
      harness: s.harness,
      title: s.title,
      project: s.projectPath,
      open: openById.get(id) ?? null,
    });
    for (const child of order(children.get(id) ?? [])) visit(child, depth + 1, path);
  };
  for (const root of order(roots)) visit(root, 0, new Set());
  return rows;
}
