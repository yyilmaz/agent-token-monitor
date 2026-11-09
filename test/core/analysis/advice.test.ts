// Pins FRESH-1, POSTCOMPACT-1, SUMMARY-1, REMAIN-1 and weighted ADVICE-1 (ADR 0017, R-51, R-60, R-62).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AdviceConfig, sessionAdvice } from "../../../src/core/analysis/advice.js";
import { analyzeCache, type CacheConfig } from "../../../src/core/analysis/cache.js";
import { openSessions } from "../../../src/core/analysis/live.js";
import type { Config } from "../../../src/core/config/config.js";
import type { Call, Event, Session } from "../../../src/core/model/index.js";

const CACHE: CacheConfig = {
  fullMissMinContextTokens: 20000,
  hitToleranceTokens: 1024,
  survivedMinCacheReadShare: 0.75,
  lifetimeBandEdgesSeconds: [60],
  minLifetimeObservations: 4,
  declaredLifetimeSeconds: { claudeCode: { m: 3600 }, antigravity: {}, codex: {}, opencode: {} },
  referenceLifetimeSeconds: { claudeCode: 300, antigravity: 300, codex: 300, opencode: 300 },
};

const RULES: Config["rules"] = {
  freshSession: { minSessions: 5 },
  sessionAdvice: { minCompactions: 5, minSessions: 5, contextBandEdgesTokens: [50000, 100000, 200000, 500000] },
};

const T = Date.parse("2026-10-31T12:00:00.000Z");
const ago = (seconds: number) => T - seconds * 1000;
let line = 0;

function call(id: string, sessionId: string, timestamp: number, context: number, model = "m", toolNames: readonly string[] = []): Call {
  line += 1;
  return {
    id,
    sessionId,
    timestamp,
    model,
    kind: "turn",
    inputUncached: 0,
    cacheRead: context,
    cacheWrite: 0,
    output: 10,
    reasoning: null,
    cacheWriteByTtlSeconds: null,
    toolNames,
    sources: [{ logRoot: "r:0", file: "f", line }],
  };
}

const session = (id: string): Session => ({ id, harness: "claudeCode", nativeId: id, parentSessionId: null, isSubagent: false, spawnedBySessionId: null, title: null, projectPath: "/p", sources: [] });

const compaction = (id: string, sessionId: string, timestamp: number, postTokens: number | null): Event => ({
  id,
  sessionId,
  timestamp,
  type: "compaction",
  childSessionId: null,
  compaction: { trigger: "manual", preTokens: 160000, postTokens },
  sources: [{ logRoot: "r:0", file: "f", line: (line += 1) }],
});

/**
 * Five past sessions: start at 80,600, enter the 100,000–200,000 band at 160,000, send 10 more messages there,
 * compact (summary 20,000) and continue at 92,000. So 11 messages follow the band entry.
 */
function history(count = 5): { sessions: Session[]; calls: Call[]; events: Event[] } {
  const sessions: Session[] = [];
  const calls: Call[] = [];
  const events: Event[] = [];
  for (let n = 0; n < count; n++) {
    const id = `h${n}`;
    const start = ago(30 * 86400 + n * 3600);
    sessions.push(session(id));
    calls.push(call(`${id}a`, id, start, 80600));
    for (let i = 0; i <= 10; i++) calls.push(call(`${id}b${i}`, id, start + (i + 1) * 10_000, 160000));
    events.push(compaction(`${id}x`, id, start + 200_000, 20000));
    calls.push(call(`${id}d`, id, start + 300_000, 92000));
  }
  return { sessions, calls, events };
}

/** The open session: started at 80,600, now at `currentContext`, last call `idleSeconds` ago. */
function live(
  idleSeconds: number,
  model = "m",
  currentContext = 160000,
  toolNames: readonly string[] = [],
  extraCalls: readonly Call[] = [],
): { sessions: Session[]; calls: Call[] } {
  return {
    sessions: [session("live")],
    calls: [
      call("l1", "live", ago(idleSeconds + 60), 80600, model, toolNames),
      ...extraCalls,
      call("l2", "live", ago(idleSeconds), currentContext, model, toolNames),
    ],
  };
}

function advise(
  idleSeconds: number,
  options: {
    past?: number;
    weights?: Config["rules"]["sessionAdvice"]["weights"];
    model?: string;
    context?: number;
    toolNames?: readonly string[];
    extraSessions?: readonly Session[];
    extraCalls?: readonly Call[];
    extraEvents?: readonly Event[];
  } = {},
) {
  const past = history(options.past);
  const now = live(idleSeconds, options.model, options.context, options.toolNames, options.extraCalls);
  const data = {
    sessions: [...past.sessions, ...now.sessions, ...(options.extraSessions ?? [])],
    calls: [...past.calls, ...now.calls],
    events: [...past.events, ...(options.extraEvents ?? [])],
  };
  const config = {
    cache: CACHE,
    models: { assumed: {} },
    liveView: { openWithinSeconds: 86400 },
    rules: options.weights === undefined ? RULES : { ...RULES, sessionAdvice: { ...RULES.sessionAdvice, weights: options.weights } },
  };
  const cache = analyzeCache(data, config);
  const open = openSessions(data, cache, config, T);
  return sessionAdvice(data, cache, open, config satisfies AdviceConfig, T);
}


describe("history figures (ADR 0017)", () => {
  const result = advise(60);

  it("FRESH-1: the typical first turn context of top-level sessions", () => {
    assert.deepEqual(result.freshStarts.map((f) => [f.model, f.sessions, f.medianContextTokens]), [["m", 6, 80600]]);
  });

  it("POSTCOMPACT-1 and SUMMARY-1: the first context after each compaction and the logged summary size", () => {
    assert.deepEqual(result.postCompactions.map((p) => [p.model, p.compactions, p.medianContextTokens]), [["m", 5, 92000]]);
    assert.deepEqual(result.summaries.map((s) => [s.model, s.compactions, s.medianTokens]), [["m", 5, 20000]]);
  });

  it("REMAIN-1: the messages after a session's context first entered each band", () => {
    const band = result.remaining.find((r) => r.fromTokens === 100000);
    // Five past sessions sent 11 more, the open one none yet: lower median of [0, 11, 11, 11, 11, 11].
    assert.deepEqual([band?.toTokens, band?.sessions, band?.medianMessages], [200000, 6, 11]);
  });

  it("are unknown below the minimum count (R-16)", () => {
    const few = advise(60, { past: 4 });
    assert.deepEqual([few.postCompactions[0]?.compactions, few.postCompactions[0]?.medianContextTokens], [4, null]);
    assert.equal(few.advice[0]?.unknownReason, "postCompactionUnknown");
  });
});

describe("ADVICE-1", () => {
  it("keeps going with a warm cache and reports weighted totals and break-even horizons", () => {
    const [a] = advise(60).advice;
    assert.deepEqual([a?.sessionId, a?.warm, a?.horizonMessages, a?.advice], ["live", true, 11, "keepGoing"]);
    assert.deepEqual(
      a?.options.map((o) => [o.option, o.oneTime, o.perMessage, o.total, o.breakEvenMessages]),
      [
        ["keepGoing", 0, 16000, 176000, 0],
        ["compact", 141000, 9200, 242200, 21],
        ["startFresh", 100750, 8060, 189410, 13],
      ],
    );
    assert.equal(a?.saving, 0);
  });

  it("starts fresh with a cold cache and counts the rebuild in the initial load", () => {
    const [a] = advise(4000).advice;
    assert.deepEqual([a?.warm, a?.advice], [false, "startFresh"]);
    assert.deepEqual(
      a?.options.map((o) => [o.option, o.oneTime, o.breakEvenMessages]),
      [
        ["keepGoing", 200000, 0],
        ["compact", 415000, 32],
        ["startFresh", 100750, 0],
      ],
    );
    assert.equal(a?.saving, 186590);
  });

  it("recommends compaction when the smaller context outweighs the summary load", () => {
    const weights = { cacheRead: 0.1, cacheWrite: 1, inputUncached: 1, output: 0 };
    const [a] = advise(60, { weights }).advice;
    assert.equal(a?.advice, "compact");
    assert.equal(a?.saving, 38800);
  });

  it("uses configured weights and keeps going when all options tie", () => {
    const weights = { cacheRead: 0, cacheWrite: 0, inputUncached: 1, output: 0 };
    const [a] = advise(60, { weights }).advice;
    assert.deepEqual(a?.weights, weights);
    assert.equal(a?.advice, "keepGoing");
    assert.deepEqual(a?.options.map((o) => [o.total, o.breakEvenMessages]), [[0, 0], [0, 0], [0, 0]]);
  });

  it("reports no break-even when a positive initial load cannot be recovered", () => {
    const weights = { cacheRead: 0, cacheWrite: 1, inputUncached: 1, output: 0 };
    const [a] = advise(60, { weights }).advice;
    assert.equal(a?.advice, "keepGoing");
    assert.deepEqual(a?.options.map((o) => o.breakEvenMessages), [0, null, null]);
  });

  it("reports missing model history while WORKFLOW-1 still computes", () => {
    const [a] = advise(60, { model: "new-model" }).advice;
    assert.deepEqual([a?.advice, a?.unknownReason, a?.options], [null, "freshStartUnknown", []]);
    assert.deepEqual(
      [
        a?.workflow.rule,
        a?.workflow.turns,
        a?.workflow.firstContextTokens,
        a?.workflow.recentGrowthTokens,
        a?.workflow.splitBreakEvenSteps,
        a?.workflow.contextState,
      ],
      ["WORKFLOW-1", 2, 80600, 79400, null, "compactActive"],
    );
  });

  it("WORKFLOW-1 distinguishes compactActive, activeWorkingSet, explorationHeavy and coldLargeContext", () => {
    const [lean] = advise(60, { context: 160000 }).advice;
    assert.equal(lean?.workflow.contextState, "compactActive");
    const [active] = advise(60, { context: 200000, toolNames: ["edit_file"] }).advice;
    assert.equal(active?.workflow.contextState, "activeWorkingSet");
    assert.equal(active?.workflow.splitBreakEvenSteps, 4);
    const [singleExplore] = advise(60, {
      context: 200000,
      extraCalls: [call("l1b", "live", ago(90), 120000, "m", ["read_file"]), call("l1c", "live", ago(80), 150000, "m", [])],
    }).advice;
    assert.equal(singleExplore?.workflow.contextState, "activeWorkingSet");
    const [explore] = advise(60, {
      context: 200000,
      toolNames: ["read_file"],
      extraCalls: [call("l1b", "live", ago(90), 140000, "m", ["read_file"])],
    }).advice;
    assert.equal(explore?.workflow.contextState, "explorationHeavy");
    const [cold] = advise(4000, { context: 200000 }).advice;
    assert.equal(cold?.workflow.contextState, "coldLargeContext");
    const [waiting] = advise(100000, {
      context: 200000,
      extraSessions: [{ ...session("sub1"), parentSessionId: "live", isSubagent: true }],
      extraCalls: [call("sub1-c1", "sub1", ago(15), 50000)],
    }).advice;
    assert.equal(waiting?.sessionId, "live");
    assert.equal(waiting?.workflow.activeSubagentCount, 1);
    assert.equal(waiting?.workflow.contextState, "waitingOnSubagents");
  });

  it("WORKFLOW-1 resets turn counts and returns compactActive after a compaction event", () => {
    const [afterCompact] = advise(60, {
      context: 200000,
      toolNames: ["read_file"],
      extraEvents: [compaction("live-c1", "live", ago(10), null)],
    }).advice;
    assert.equal(afterCompact?.workflow.turns, 0);
    assert.equal(afterCompact?.workflow.exploreTurns, 0);
    assert.equal(afterCompact?.workflow.contextState, "compactActive");
    assert.equal(afterCompact?.workflow.splitBreakEvenSteps, null);
  });

  it("computes weighted step load, active window avg and recent avg across compactions", () => {
    const [a] = advise(60, { context: 200000, toolNames: ["edit_file"] }).advice;
    // Turn 1: 80,600 cacheRead (8,060) + 20 output (100) = 8,160.
    // Turn 2: 200,000 cacheRead (20,000) + 20 output (100) = 20,100.
    assert.equal(a?.workflow.sessionWeightedTokens, 28160);
    assert.equal(a?.workflow.activeWindowAvgWeightedTokens, 14080);
    assert.equal(a?.workflow.recentAvgWeightedTokens, 14080);
  });
});
