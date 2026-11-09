// Cache analysis: classification, survival observations, observed and declared lifetime, and miss causes
// (ADR 0009, R-40 to R-44). Pure functions over the model of ADR 0008.
//
// Every model below is the effective model of MODEL-1: the logged one, or the configured assumption.
// Pairs (PAIR-1) are formed over turn calls; compaction calls lie between them like compaction events.

import type { Config } from "../config/config.js";
import type { Call, Event, HarnessId, Session } from "../model/index.js";
import { compareByTimeThenSource, compareStrings } from "../order.js";
import { type DistributionPoint, lifetimeDistribution, medianLifetimeSeconds } from "./lifetime.js";

export type CacheConfig = Config["cache"];

/** The configuration sections this analysis reads. */
export type CacheAnalysisConfig = Pick<Config, "cache" | "models">;

/** Where an effective model came from (MODEL-1). */
export type ModelSource = "logged" | "assumed";

export type CacheClass = "unknown" | "first" | "belowThreshold" | "fullMiss" | "hit" | "partial";

export type MissCauseKind = "modelSwitch" | "compaction" | "idleBeyondLifetime" | "prematureLoss";

/** Where the reference lifetime of CAUSE-1 came from. */
export type ReferenceSource = "declared" | "observed" | "configured";

export interface MissCause {
  readonly rule: "CAUSE-1";
  readonly cause: MissCauseKind;
  /** Set for idleBeyondLifetime and prematureLoss, the causes that compare against a lifetime. */
  readonly referenceLifetimeSeconds: number | null;
  readonly referenceSource: ReferenceSource | null;
}

export interface CallCacheResult {
  readonly callId: string;
  readonly sessionId: string;
  readonly harness: HarnessId;
  /** Effective model (MODEL-1). */
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  readonly rule: "CLS-1";
  readonly class: CacheClass;
  /** LOSS-1: the session's own cache was gone (a full miss, or a partial hit with a small read share). */
  readonly cacheLoss: boolean;
  /** Tokens of the previous context paid at full price again; null when it cannot be computed. */
  readonly reReadTokens: number | null;
  readonly previousCallId: string | null;
  /** Derived (PAIR-1): time between the recorded timestamps of the two calls. */
  readonly gapSeconds: number | null;
  readonly prefixTokens: number | null;
  /** DECL-1, for the cache the previous call left behind. */
  readonly declaredLifetimeSeconds: number | null;
  /** A compaction event or compaction call lies between the previous call and this one (PAIR-1). */
  readonly compactionBetween: boolean;
  /** Survival observation (OBS-1): "survived", "gone", or null when the pair is not one. */
  readonly observation: "survived" | "gone" | null;
  readonly cause: MissCause | null;
}

export interface GapBand {
  readonly fromSeconds: number;
  /** Exclusive upper edge; null for the last, open band. */
  readonly toSeconds: number | null;
  readonly survived: number;
  readonly gone: number;
}

export interface LifetimeGroup {
  readonly rule: "LIFE-1";
  readonly harness: HarnessId;
  readonly model: string;
  readonly modelSource: ModelSource;
  /** DECL-1 of the pairs in the group: a cache promised 5 minutes and one promised an hour are measured apart. */
  readonly declaredLifetimeSeconds: number | null;
  readonly survived: number;
  readonly gone: number;
  readonly longestSurvivedSeconds: number | null;
  readonly shortestGoneSeconds: number | null;
  readonly distribution: readonly DistributionPoint[];
  /** Typical lifetime; null when the data is insufficient. */
  readonly medianSeconds: number | null;
  readonly sufficient: boolean;
  readonly bands: readonly GapBand[];
}

/** DECL-1 per harness and model: what the harness promised, so the reader can compare it with the observed lifetime. */
export interface DeclaredGroup {
  readonly rule: "DECL-1";
  readonly harness: HarnessId;
  readonly model: string;
  readonly modelSource: ModelSource;
  /**
   * Calls per declared lifetime, ascending, with calls that have none (`seconds: null`) last. A session's first
   * call is left out: there is no earlier cache it could have been promised.
   */
  readonly lifetimes: readonly { readonly seconds: number | null; readonly calls: number }[];
  /** The most recent declared lifetime in the group; null when none was ever declared. */
  readonly latestSeconds: number | null;
}

export interface CacheAnalysis {
  readonly calls: readonly CallCacheResult[];
  readonly lifetimes: readonly LifetimeGroup[];
  readonly declared: readonly DeclaredGroup[];
}

export interface CacheInput {
  readonly sessions: readonly Session[];
  readonly calls: readonly Call[];
  readonly events: readonly Event[];
}

type Ordered = Pick<Call, "timestamp" | "sources">;

export interface EffectiveModel {
  readonly name: string | null;
  readonly source: ModelSource | null;
}

interface Pair {
  readonly call: Call;
  readonly harness: HarnessId;
  readonly model: EffectiveModel;
  readonly previousModel: EffectiveModel | null;
  readonly previous: Call | null;
  readonly gapMillis: number | null;
  readonly cls: CacheClass;
  readonly cacheLoss: boolean;
  readonly reReadTokens: number | null;
  readonly prefixTokens: number | null;
  readonly declared: number | null;
  readonly compactionBetween: boolean;
  readonly observation: "survived" | "gone" | null;
}

export function analyzeCache(input: CacheInput, settings: CacheAnalysisConfig): CacheAnalysis {
  const config = settings.cache;
  const assumed = settings.models.assumed;
  const harnessOf = new Map(input.sessions.map((s) => [s.id, s.harness]));
  const bySession = new Map<string, { turns: Call[]; compactions: Ordered[] }>();
  const slot = (sessionId: string) => {
    let entry = bySession.get(sessionId);
    if (entry === undefined) bySession.set(sessionId, (entry = { turns: [], compactions: [] }));
    return entry;
  };
  for (const call of input.calls) {
    if (call.kind === "turn") slot(call.sessionId).turns.push(call);
    else slot(call.sessionId).compactions.push(call);
  }
  for (const event of input.events) if (event.type === "compaction") slot(event.sessionId).compactions.push(event);

  const pairs: Pair[] = [];
  for (const [sessionId, { turns, compactions }] of [...bySession].sort(([a], [b]) => compareStrings(a, b))) {
    const harness = harnessOf.get(sessionId);
    if (harness === undefined) continue;
    turns.sort((a, b) => compareByTimeThenSource(a, b) || compareStrings(a.id, b.id));
    compactions.sort(compareByTimeThenSource);
    let declaredFromLog: number | null = null;
    turns.forEach((call, index) => {
      const previous = index === 0 ? null : (turns[index - 1] as Call);
      if (previous !== null) declaredFromLog = loggedLifetime(previous) ?? declaredFromLog;
      const model = effectiveModel(call, harness, assumed);
      const previousModel = previous === null ? null : effectiveModel(previous, harness, assumed);
      const declared = declaredFromLog ?? configuredLifetime(config, harness, model.name);
      pairs.push(pairOf(call, harness, model, previous, previousModel, declared, compactions, config));
    });
  }

  // Canonical call order for the result (ADR 0008 rule 7).
  pairs.sort((a, b) => compareByTimeThenSource(a.call, b.call) || compareStrings(a.call.id, b.call.id));
  const lifetimes = lifetimeGroups(pairs, config);
  const median = new Map(lifetimes.map((g) => [declaredKey(groupKey(g.harness, g.model, g.modelSource), g.declaredLifetimeSeconds), g.medianSeconds]));

  const calls = pairs.map((pair): CallCacheResult => ({
    callId: pair.call.id,
    sessionId: pair.call.sessionId,
    harness: pair.harness,
    model: pair.model.name,
    modelSource: pair.model.source,
    rule: "CLS-1",
    class: pair.cls,
    cacheLoss: pair.cacheLoss,
    reReadTokens: pair.reReadTokens,
    previousCallId: pair.previous?.id ?? null,
    gapSeconds: pair.gapMillis === null ? null : pair.gapMillis / 1000,
    prefixTokens: pair.prefixTokens,
    declaredLifetimeSeconds: pair.declared,
    compactionBetween: pair.compactionBetween,
    observation: pair.observation,
    cause: pair.cacheLoss ? missCause(pair, median, config) : null,
  }));

  return {
    calls,
    lifetimes,
    declared: declaredGroups(pairs),
  };
}

/** DECL-1 summarized per harness and known model; `pairs` are in canonical call order, so the last one is the latest. */
function declaredGroups(pairs: readonly Pair[]): DeclaredGroup[] {
  const groups = new Map<string, { first: Pair; counts: Map<number | null, number>; latest: number | null }>();
  for (const pair of pairs) {
    if (pair.model.name === null || pair.previous === null) continue;
    const key = pairKey(pair);
    let group = groups.get(key);
    if (group === undefined) {
      group = { first: pair, counts: new Map(), latest: null };
      groups.set(key, group);
    }
    group.counts.set(pair.declared, (group.counts.get(pair.declared) ?? 0) + 1);
    if (pair.declared !== null) group.latest = pair.declared;
  }
  return [...groups]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, g]) => ({
      rule: "DECL-1",
      harness: g.first.harness,
      model: g.first.model.name as string,
      modelSource: g.first.model.source as ModelSource,
      lifetimes: [...g.counts]
        .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
        .map(([seconds, calls]) => ({ seconds, calls })),
      latestSeconds: g.latest,
    }));
}

function pairOf(
  call: Call,
  harness: HarnessId,
  model: EffectiveModel,
  previous: Call | null,
  previousModel: EffectiveModel | null,
  declared: number | null,
  compactions: readonly Ordered[],
  config: CacheConfig,
): Pair {
  const context = contextSize(call);
  const prefixTokens = previous === null ? null : contextSize(previous);
  const gapMillis = previous === null ? null : call.timestamp - previous.timestamp;
  const compactionBetween =
    previous !== null &&
    compactions.some((c) => compareByTimeThenSource(previous, c) < 0 && compareByTimeThenSource(c, call) < 0);

  let cls: CacheClass;
  let reReadTokens: number | null = null;
  if (call.cacheRead === null || context === null) cls = "unknown";
  else {
    if (prefixTokens !== null) reReadTokens = Math.max(0, Math.min(prefixTokens, context) - call.cacheRead);
    if (previous === null) cls = "first";
    else if (call.cacheRead === 0 && context < config.fullMissMinContextTokens) cls = "belowThreshold";
    else if (call.cacheRead === 0) cls = "fullMiss";
    else if (reReadTokens === null) cls = "unknown";
    else if (reReadTokens <= config.hitToleranceTokens) cls = "hit";
    else cls = "partial";
  }

  // LOSS-1: a partial hit that read only a small share of the previous context lost the session's own cache.
  const cacheLoss =
    cls === "fullMiss" ||
    (cls === "partial" && (call.cacheRead as number) < config.survivedMinCacheReadShare * (prefixTokens as number));

  const sameKnownModel = model.name !== null && previousModel?.name === model.name;
  const observation =
    sameKnownModel && !compactionBetween && (cls === "hit" || cls === "partial" || cls === "fullMiss")
      ? cacheLoss ? "gone" : "survived"
      : null;

  return {
    call,
    harness,
    model,
    previousModel,
    previous,
    gapMillis,
    cls,
    cacheLoss,
    reReadTokens,
    prefixTokens,
    declared,
    compactionBetween,
    observation,
  };
}

/** MODEL-1: the logged model, or the configured assumption for a harness whose log has none. */
export function effectiveModel(call: Call, harness: HarnessId, assumed: Readonly<Record<string, string>>): EffectiveModel {
  if (call.model !== null) return { name: call.model, source: "logged" };
  const name = Object.hasOwn(assumed, harness) ? (assumed[harness] as string) : null;
  return name === null ? { name: null, source: null } : { name, source: "assumed" };
}

/** DECL-1 step 1: the largest lifetime with non-zero cache-write tokens, when the log splits them. */
export function loggedLifetime(call: Call): number | null {
  if (call.cacheWriteByTtlSeconds === null) return null;
  let largest: number | null = null;
  for (const [ttl, tokens] of Object.entries(call.cacheWriteByTtlSeconds)) {
    const seconds = Number(ttl);
    if (tokens > 0 && Number.isSafeInteger(seconds) && (largest === null || seconds > largest)) largest = seconds;
  }
  return largest;
}

/** DECL-1 step 2: the configured lifetime for this harness and model. */
function configuredLifetime(config: CacheConfig, harness: HarnessId, model: string | null): number | null {
  if (model === null) return null;
  return Object.hasOwn(config.declaredLifetimeSeconds[harness], model)
    ? (config.declaredLifetimeSeconds[harness][model] as number)
    : null;
}

function missCause(pair: Pair, median: ReadonlyMap<string, number | null>, config: CacheConfig): MissCause {
  const previousName = pair.previousModel?.name ?? null;
  if (previousName !== null && pair.model.name !== null && previousName !== pair.model.name) {
    return { rule: "CAUSE-1", cause: "modelSwitch", referenceLifetimeSeconds: null, referenceSource: null };
  }
  if (pair.compactionBetween) {
    return { rule: "CAUSE-1", cause: "compaction", referenceLifetimeSeconds: null, referenceSource: null };
  }
  // Only reached without a declared lifetime, so the observed median is that of the pairs with none.
  const observed = pair.model.name === null ? null : (median.get(declaredKey(pairKey(pair), null)) ?? null);
  const [seconds, source]: [number, ReferenceSource] =
    pair.declared !== null
      ? [pair.declared, "declared"]
      : observed !== null
        ? [observed, "observed"]
        : [config.referenceLifetimeSeconds[pair.harness], "configured"];
  const cause = (pair.gapMillis as number) > seconds * 1000 ? "idleBeyondLifetime" : "prematureLoss";
  return { rule: "CAUSE-1", cause, referenceLifetimeSeconds: seconds, referenceSource: source };
}

function lifetimeGroups(pairs: readonly Pair[], config: CacheConfig): LifetimeGroup[] {
  const groups = new Map<string, Pair[]>();
  for (const pair of pairs) {
    if (pair.observation === null) continue;
    const key = declaredKey(pairKey(pair), pair.declared);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [pair]);
    else list.push(pair);
  }

  const result: LifetimeGroup[] = [];
  for (const [key, list] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
    list.sort((a, b) => (a.gapMillis as number) - (b.gapMillis as number) || compareByTimeThenSource(a.call, b.call));
    const survivedGaps = list.filter((p) => p.observation === "survived").map((p) => p.gapMillis as number);
    const goneGaps = list.filter((p) => p.observation === "gone").map((p) => p.gapMillis as number);
    const distribution = lifetimeDistribution(list.map((p) => ({ gapMillis: p.gapMillis as number, gone: p.observation === "gone" })));
    const sufficient = list.length >= config.minLifetimeObservations && survivedGaps.length > 0 && goneGaps.length > 0;
    const first = list[0] as Pair;
    result.push({
      rule: "LIFE-1",
      harness: first.harness,
      model: first.model.name as string,
      modelSource: first.model.source as ModelSource,
      declaredLifetimeSeconds: first.declared,
      survived: survivedGaps.length,
      gone: goneGaps.length,
      longestSurvivedSeconds: survivedGaps.length === 0 ? null : Math.max(...survivedGaps) / 1000,
      shortestGoneSeconds: goneGaps.length === 0 ? null : Math.min(...goneGaps) / 1000,
      distribution,
      medianSeconds: sufficient ? medianLifetimeSeconds(distribution) : null,
      sufficient,
      bands: gapBands(list, config.lifetimeBandEdgesSeconds),
    });
  }
  return result;
}

function gapBands(pairs: readonly Pair[], edges: readonly number[]): GapBand[] {
  const bounds = [0, ...edges];
  return bounds.map((from, index) => {
    const to = index + 1 < bounds.length ? (bounds[index + 1] as number) : null;
    const inBand = pairs.filter((p) => {
      const gap = p.gapMillis as number;
      return gap >= from * 1000 && (to === null || gap < to * 1000);
    });
    return {
      fromSeconds: from,
      toSeconds: to,
      survived: inBand.filter((p) => p.observation === "survived").length,
      gone: inBand.filter((p) => p.observation === "gone").length,
    };
  });
}

function contextSize(call: Call): number | null {
  if (call.inputUncached === null || call.cacheRead === null || call.cacheWrite === null) return null;
  return call.inputUncached + call.cacheRead + call.cacheWrite;
}

/** Groups never mix a logged model with an assumed one of the same name (MODEL-1). */
function groupKey(harness: HarnessId, model: string, source: ModelSource): string {
  return `${harness}\u0000${model}\u0000${source}`;
}

function pairKey(pair: Pair): string {
  return groupKey(pair.harness, pair.model.name as string, pair.model.source as ModelSource);
}

/** A group key refined by declared lifetime; sorts ascending by seconds, with none last. */
function declaredKey(key: string, declared: number | null): string {
  return `${key}\u0000${declared === null ? "~" : String(declared).padStart(12, "0")}`;
}
