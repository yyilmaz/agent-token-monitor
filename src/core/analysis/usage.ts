// Usage totals per day, month and session (ADR 0013 rule USE-1, R-33). Pure functions; the time zone is an input.

import type { Config } from "../config/config.js";
import type { Call, EpochMillis, HarnessId, Session } from "../model/index.js";
import { compareStrings } from "../order.js";
import { callWeightedTokens, DEFAULT_TOKEN_WEIGHTS, type TokenWeights } from "./advice.js";
import { effectiveModel, type ModelSource } from "./cache.js";

export type UsagePeriodKind = "day" | "month" | "session";

/** A token field summed over the calls that record it, with the number of calls where it is unknown (R-16). */
export interface TokenSum {
  readonly total: number;
  readonly unknownCalls: number;
}

export interface UsageFigures {
  readonly calls: number;
  readonly inputUncached: TokenSum;
  readonly cacheRead: TokenSum;
  readonly cacheWrite: TokenSum;
  readonly output: TokenSum;
  readonly reasoning: TokenSum;
}

export interface UsageSplit {
  readonly harness: HarnessId | null;
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  /** Logged project path; null when unknown. Not part of a harness or model split. */
  readonly project: string | null;
  readonly figures: UsageFigures;
  /** Per-harness weighted load for Usage charts (ADR 0013, ADR 0017). */
  readonly weightedTokenUnits?: TokenSum;
}

export interface UsagePeriod {
  readonly rule: "USE-1";
  /** "YYYY-MM-DD", "YYYY-MM" or a session ID. */
  readonly period: string;
  readonly total: UsageFigures;
  /** Sum of per-call rounded load (ADR 0017, R-51). */
  readonly weightedTokenUnits: TokenSum;
  readonly byHarness: readonly UsageSplit[];
  readonly byModel: readonly UsageSplit[];
  readonly byProject: readonly UsageSplit[];
}

export interface UsageCall {
  readonly call: Call;
  readonly harness: HarnessId;
  readonly model: string | null;
  readonly modelSource: ModelSource | null;
  readonly project: string | null;
}

/** Every call with its effective model (MODEL-1), in input order. */
export function usageCalls(
  calls: readonly Call[],
  sessions: readonly Session[],
  settings: Pick<Config, "models">,
): UsageCall[] {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const result: UsageCall[] = [];
  for (const call of calls) {
    const session = sessionById.get(call.sessionId);
    if (session === undefined) continue;
    const model = effectiveModel(call, session.harness, settings.models.assumed);
    result.push({
      call,
      harness: session.harness,
      model: model.name,
      modelSource: model.source,
      project: session.projectPath,
    });
  }
  return result;
}

/** USE-1: totals per period, each split by harness, effective model and project. */
export function usageTotals(calls: readonly UsageCall[], kind: UsagePeriodKind, timeZone: string, weights: TokenWeights = DEFAULT_TOKEN_WEIGHTS): UsagePeriod[] {
  const periodOf = periodFunction(kind, timeZone);
  const periods = new Map<string, UsageCall[]>();
  for (const c of calls) {
    const key = periodOf(c);
    const list = periods.get(key);
    if (list === undefined) periods.set(key, [c]);
    else list.push(c);
  }
  return [...periods]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([period, list]) => ({
      rule: "USE-1",
      period,
      total: figures(list),
      weightedTokenUnits: weightedLoad(list, weights),
      byHarness: split(list, (c) => ({ harness: c.harness, model: null, modelSource: null, project: null }), weights),
      byModel: split(list, (c) => ({ harness: c.harness, model: c.model, modelSource: c.modelSource, project: null })),
      byProject: split(list, (c) => ({ harness: null, model: null, modelSource: null, project: c.project })),
    }));
}

function weightedLoad(calls: readonly UsageCall[], weights: TokenWeights): TokenSum {
  let total = 0;
  let unknownCalls = 0;
  for (const { call } of calls) {
    const units = callWeightedTokens(call, weights);
    if (units === null) unknownCalls += 1;
    else total += units;
  }
  return { total, unknownCalls };
}

/** The calendar day ("YYYY-MM-DD") of an instant in a time zone. */
export function dayIn(timestamp: EpochMillis, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(timestamp);
  const part = (type: string) => parts.find((p) => p.type === type)?.value as string;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" });
    formatters.set(timeZone, f);
  }
  return f;
}

function periodFunction(kind: UsagePeriodKind, timeZone: string): (c: UsageCall) => string {
  if (kind === "session") return (c) => c.call.sessionId;
  if (kind === "day") return (c) => dayIn(c.call.timestamp, timeZone);
  return (c) => dayIn(c.call.timestamp, timeZone).slice(0, 7);
}

type SplitKey = Omit<UsageSplit, "figures" | "weightedTokenUnits">;

function split(calls: readonly UsageCall[], keyOf: (c: UsageCall) => SplitKey, weights?: TokenWeights): UsageSplit[] {
  const groups = new Map<string, { key: SplitKey; calls: UsageCall[] }>();
  for (const c of calls) {
    const key = keyOf(c);
    const id = JSON.stringify([key.harness, key.model, key.modelSource, key.project]);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { key, calls: [c] });
    else group.calls.push(c);
  }
  return [...groups].sort(([a], [b]) => compareStrings(a, b)).map(([, g]) => ({
    ...g.key,
    figures: figures(g.calls),
    ...(weights === undefined ? {} : { weightedTokenUnits: weightedLoad(g.calls, weights) }),
  }));
}

function figures(calls: readonly UsageCall[]): UsageFigures {
  const sum = (field: "inputUncached" | "cacheRead" | "cacheWrite" | "output" | "reasoning"): TokenSum => {
    let total = 0;
    let unknownCalls = 0;
    for (const c of calls) {
      const value = c.call[field];
      if (value === null) unknownCalls += 1;
      else total += value;
    }
    return { total, unknownCalls };
  };
  return {
    calls: calls.length,
    inputUncached: sum("inputUncached"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    reasoning: sum("reasoning"),
  };
}
