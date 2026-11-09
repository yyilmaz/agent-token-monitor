// Pins the session advice of ADR 0017: FRESH-1, POSTCOMPACT-1, SUMMARY-1, REMAIN-1 and ADVICE-1 (R-60, R-62), on the
// ADR's worked example: Opus-like prices, a fresh start of 80,600, 92,000 after compacting, a 20,000-token summary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AdviceConfig, sessionAdvice } from "../../../src/core/analysis/advice.js";
import { analyzeCache, type CacheConfig } from "../../../src/core/analysis/cache.js";
import { openSessions } from "../../../src/core/analysis/live.js";
import type { Config } from "../../../src/core/config/config.js";
import type { Call, Event, Session } from "../../../src/core/model/index.js";
import { priceTable } from "../../../src/core/pricing/price.js";

const CACHE: CacheConfig = {
  fullMissMinContextTokens: 20000,
  hitToleranceTokens: 1024,
  survivedMinCacheReadShare: 0.75,
  lifetimeBandEdgesSeconds: [60],
  minLifetimeObservations: 4,
  // DECL-1 step 2: every call of model m declares a one-hour cache, so writes are priced at 8.
  declaredLifetimeSeconds: { claudeCode: { m: 3600 }, antigravity: {}, codex: {}, opencode: {} },
  referenceLifetimeSeconds: { claudeCode: 300, antigravity: 300, codex: 300, opencode: 300 },
};

const RULES: Config["rules"] = {
  freshSession: { minSessions: 5 },
  sessionAdvice: { minCompactions: 5, minSessions: 5, contextBandEdgesTokens: [50000, 100000, 200000, 500000] },
};

/** Claude Opus 5.5's list prices (ADR 0011, 2026-11-01). */
const PRICING: Config["pricing"] = {
  currency: "USD",
  displayDecimals: 2,
  models: {
    m: {
      effectiveDate: "2026-11-01",
      tiers: [{ minContextTokens: 0, inputPerMillionTokens: 4, outputPerMillionTokens: 20, cacheReadPerMillionTokens: 0.2, cacheWritePerMillionTokensByTtlSeconds: { "300": 5, "3600": 8 } }],
    },
  },
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
    rules: RULES,
    pricing: PRICING,
  };
  const table = priceTable(config.pricing);
  const cache = analyzeCache(data, config);
  const open = openSessions(data, cache, config, T);
  return sessionAdvice(data, cache, open, config satisfies AdviceConfig, table, T);
}

const money = (value: string | null | undefined) => (value == null ? null : Number(value).toFixed(6));

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
  it("warm at 160,000: keep going; compacting pays off after 44 messages, a new session after 41", () => {
    const [a] = advise(60).advice;
    assert.deepEqual([a?.sessionId, a?.warm, a?.writeLifetimeSeconds, a?.horizonMessages, a?.advice], ["live", true, 3600, 11, "keepGoing"]);
    assert.deepEqual(
      a?.options.map((o) => [o.option, money(o.oneTime), money(o.perMessage), money(o.total), o.breakEvenMessages]),
      [
        ["keepGoing", "0.000000", "0.032000", "0.352000", 0],
        // 160,000 × 0.2 + 20,000 × 20 + 20,000 × 8 (only the summary is written; the rest stays cached).
        ["compact", "0.592000", "0.018400", "0.794400", 44],
        ["startFresh", "0.644800", "0.016120", "0.822120", 41],
      ],
    );
    assert.equal(money(a?.saving), "0.000000");
  });

  it("cold at 160,000: start fresh, and compacting is the most expensive option", () => {
    const [a] = advise(4000).advice;
    assert.deepEqual([a?.warm, a?.advice], [false, "startFresh"]);
    assert.deepEqual(
      a?.options.map((o) => [o.option, money(o.oneTime)]),
      [
        ["keepGoing", "1.280000"],
        // 160,000 written again, the summary output, then 92,000 written after compacting.
        ["compact", "2.416000"],
        ["startFresh", "0.644800"],
      ],
    );
    assert.equal(money(a?.saving), "0.809880");
  });

  it("is unknown for a model without a price, while WORKFLOW-1 still computes", () => {
    const [a] = advise(60, { model: "unpriced" }).advice;
    assert.deepEqual([a?.advice, a?.unknownReason, a?.options], [null, "unpricedModel", []]);
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
