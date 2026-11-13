// Pins the cache rules of ADR 0009: MODEL-1, PAIR-1, CLS-1, LOSS-1, OBS-1, LIFE-1, DECL-1, CAUSE-1
// (R-40 to R-44).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeCache, type CacheConfig, type CacheInput } from "../../../src/core/analysis/cache.js";
import { lifetimeDistribution, medianLifetimeSeconds } from "../../../src/core/analysis/lifetime.js";
import type { Call, Event, HarnessId, Session } from "../../../src/core/model/index.js";

const CONFIG: CacheConfig = {
  fullMissMinContextTokens: 20000,
  hitToleranceTokens: 1024,
  survivedMinCacheReadShare: 0.75,
  lifetimeBandEdgesSeconds: [60, 300, 900, 1800, 3600, 7200, 21600, 86400],
  minLifetimeObservations: 4,
  declaredLifetimeSeconds: { claudeCode: {}, antigravity: {}, codex: {}, opencode: {} },
  referenceLifetimeSeconds: { claudeCode: 300, antigravity: 300, codex: 300, opencode: 300 },
};

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
let line = 0;

interface CallSpec {
  readonly id: string;
  readonly at: number;
  readonly uncached?: number | null;
  readonly read?: number | null;
  readonly write?: number | null;
  readonly model?: string | null;
  readonly ttl?: Record<string, number> | null;
  readonly kind?: Call["kind"];
  readonly session?: string;
}

function call(spec: CallSpec): Call {
  line += 1;
  return {
    id: spec.id,
    sessionId: spec.session ?? "s",
    timestamp: T0 + spec.at * 1000,
    model: spec.model === undefined ? "m" : spec.model,
    kind: spec.kind ?? "turn",
    inputUncached: spec.uncached === undefined ? 10 : spec.uncached,
    cacheRead: spec.read === undefined ? 0 : spec.read,
    cacheWrite: spec.write === undefined ? 0 : spec.write,
    output: 1,
    reasoning: null,
    cacheWriteByTtlSeconds: spec.ttl ?? null,
    toolNames: [],
    shellClasses: [],
    sources: [{ logRoot: "r:0", file: "f", line }],
  };
}

function session(id: string, harness: HarnessId = "claudeCode"): Session {
  return { id, harness, nativeId: id, parentSessionId: null, isSubagent: false, spawnedBySessionId: null, title: null, projectPath: null, sources: [] };
}

function compactionEvent(at: number, sessionId = "s"): Event {
  line += 1;
  return { id: `e${line}`, sessionId, timestamp: T0 + at * 1000, type: "compaction", childSessionId: null, compaction: null, sources: [{ logRoot: "r:0", file: "f", line }] };
}

function input(calls: Call[], events: Event[] = [], sessions: Session[] = [session("s")]): CacheInput {
  return { sessions, calls, events };
}

const result = (data: CacheInput, config: CacheConfig = CONFIG, assumed: Record<string, string> = {}) =>
  analyzeCache(data, { cache: config, models: { assumed } });
const byId = (data: CacheInput, config: CacheConfig = CONFIG, assumed: Record<string, string> = {}) =>
  new Map(result(data, config, assumed).calls.map((c) => [c.callId, c]));

describe("CLS-1 classification", () => {
  const calls = byId(
    input([
      call({ id: "first", at: 0, uncached: 30000 }),
      call({ id: "hit", at: 10, uncached: 500, read: 30000 }),
      // previous context 30500; reads 29000 → re-reads 1500 > tolerance
      call({ id: "partial", at: 20, uncached: 1600, read: 29000 }),
      call({ id: "unknownRead", at: 30, read: null }),
      // previous context is unknown: only unknown, first, belowThreshold or fullMiss can apply
      call({ id: "afterUnknown", at: 40, uncached: 100, read: 30000 }),
      call({ id: "fullMiss", at: 50, uncached: 30200 }),
      call({ id: "small", at: 60, uncached: 5000 }),
    ]),
  );

  it("labels each call by the first matching row of the table", () => {
    assert.deepEqual(
      [...calls.values()].map((c) => [c.callId, c.class]),
      [
        ["first", "first"],
        ["hit", "hit"],
        ["partial", "partial"],
        ["unknownRead", "unknown"],
        ["afterUnknown", "unknown"],
        ["fullMiss", "fullMiss"],
        ["small", "belowThreshold"],
      ],
    );
  });

  it("re-read tokens = max(0, min(prefix, context) − cacheRead)", () => {
    assert.equal(calls.get("hit")?.reReadTokens, 0);
    assert.equal(calls.get("partial")?.reReadTokens, 30500 - 29000);
    assert.equal(calls.get("fullMiss")?.reReadTokens, 30100);
    assert.equal(calls.get("small")?.reReadTokens, 5000);
  });

  it("derives the gap and prefix from the previous call of the same session (PAIR-1)", () => {
    assert.equal(calls.get("hit")?.gapSeconds, 10);
    assert.equal(calls.get("hit")?.prefixTokens, 30000);
    assert.equal(calls.get("hit")?.previousCallId, "first");
    assert.equal(calls.get("first")?.gapSeconds, null);
  });

  it("pairs only turn calls; a compaction call counts as lying between", () => {
    const c = byId(
      input([
        call({ id: "a", at: 0, uncached: 30000 }),
        call({ id: "compact", at: 5, uncached: null, read: null, write: null, model: null, kind: "compaction" }),
        call({ id: "b", at: 10, uncached: 30000 }),
      ]),
    );
    assert.equal(c.has("compact"), false);
    assert.equal(c.get("b")?.previousCallId, "a");
    assert.equal(c.get("b")?.cause?.cause, "compaction");
    assert.equal(c.get("b")?.observation, null);
  });
});

describe("LOSS-1 cache loss", () => {
  // Previous context 200000; the shared beginning (40000) is still cached, the session's own history is not.
  const c = byId(
    input([
      call({ id: "a", at: 0, uncached: 200000 }),
      call({ id: "b", at: 10, uncached: 0, read: 200000 }),
      call({ id: "lost", at: 50000, uncached: 160000, read: 40000 }),
      // reads exactly 75% of the previous context: not a loss
      call({ id: "kept", at: 50010, uncached: 50000, read: 150000 }),
    ]),
  );

  it("marks a partial hit that read less than the configured share of the previous context as a loss", () => {
    assert.equal(c.get("lost")?.class, "partial");
    assert.equal(c.get("lost")?.cacheLoss, true);
    assert.equal(c.get("lost")?.observation, "gone");
    assert.equal(c.get("lost")?.cause?.cause, "idleBeyondLifetime");
  });

  it("keeps a partial hit at or above the share as survived, without a cause", () => {
    assert.equal(c.get("kept")?.class, "partial");
    assert.equal(c.get("kept")?.cacheLoss, false);
    assert.equal(c.get("kept")?.observation, "survived");
    assert.equal(c.get("kept")?.cause, null);
  });

  it("always counts a full miss as a loss", () => {
    const m = byId(input([call({ id: "a", at: 0, uncached: 30000 }), call({ id: "b", at: 10, uncached: 30000 })]));
    assert.equal(m.get("b")?.cacheLoss, true);
  });
});

describe("MODEL-1 effective model", () => {
  const sessions = [session("g", "antigravity"), session("s")];
  const data = input(
    [
      call({ id: "g0", at: 0, uncached: 30000, model: null, session: "g" }),
      call({ id: "g1", at: 10, read: 30000, model: null, session: "g" }),
      call({ id: "s0", at: 0, uncached: 30000, model: null }),
      call({ id: "s1", at: 10, read: 30000 }),
    ],
    [],
    sessions,
  );

  it("uses the configured model only for calls of that harness whose log has none", () => {
    const c = byId(data, CONFIG, { antigravity: "g-model" });
    assert.deepEqual([c.get("g1")?.model, c.get("g1")?.modelSource], ["g-model", "assumed"]);
    assert.equal(c.get("g1")?.observation, "survived");
    assert.deepEqual([c.get("s0")?.model, c.get("s0")?.modelSource], [null, null]);
    assert.deepEqual([c.get("s1")?.model, c.get("s1")?.modelSource], ["m", "logged"]);
  });

  it("labels lifetime groups built from assumed models", () => {
    const groups = result(data, CONFIG, { antigravity: "g-model" }).lifetimes;
    assert.deepEqual(groups.map((g) => [g.harness, g.model, g.modelSource]), [["antigravity", "g-model", "assumed"]]);
  });

  it("observes nothing for a harness without a logged or assumed model", () => {
    assert.equal(byId(data).get("g1")?.observation, null);
    assert.equal(result(data).lifetimes.length, 0);
  });
});

describe("OBS-1 survival observations", () => {
  it("counts hit and partial as survived, full miss as gone, on the same known model only", () => {
    const c = byId(
      input([
        call({ id: "a", at: 0, uncached: 30000 }),
        call({ id: "hit", at: 10, read: 30000 }),
        call({ id: "miss", at: 400, uncached: 30010 }),
        call({ id: "switch", at: 410, uncached: 30010, model: "other" }),
        call({ id: "noModel", at: 420, read: 30010, model: null }),
        call({ id: "small", at: 430, uncached: 100, model: null }),
      ]),
    );
    assert.deepEqual(
      [...c.values()].map((x) => x.observation),
      [null, "survived", "gone", null, null, null],
    );
  });

  it("excludes pairs with a compaction event between them", () => {
    const c = byId(
      input([call({ id: "a", at: 0, uncached: 30000 }), call({ id: "b", at: 10, uncached: 30000 })], [compactionEvent(5)]),
    );
    assert.equal(c.get("b")?.observation, null);
    assert.equal(c.get("b")?.cause?.cause, "compaction");
  });
});

describe("LIFE-1 observed lifetime", () => {
  it("applies pool-adjacent-violators to 0/1 values in gap order, as exact fractions", () => {
    const distribution = lifetimeDistribution([
      { gapMillis: 10000, gone: false },
      { gapMillis: 20000, gone: true },
      { gapMillis: 30000, gone: false },
      { gapMillis: 40000, gone: true },
    ]);
    assert.deepEqual(
      distribution.map((p) => [p.gapSeconds, p.numerator, p.denominator]),
      [
        [10, 0, 1],
        [20, 1, 2],
        [30, 1, 2],
        [40, 1, 1],
      ],
    );
    assert.equal(medianLifetimeSeconds(distribution), 20);
  });

  it("pools tied gaps first, so the order of tied observations does not matter", () => {
    const a = lifetimeDistribution([{ gapMillis: 1000, gone: true }, { gapMillis: 1000, gone: false }]);
    const b = lifetimeDistribution([{ gapMillis: 1000, gone: false }, { gapMillis: 1000, gone: true }]);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((p) => [p.gapSeconds, p.numerator, p.denominator]), [[1, 1, 2]]);
  });

  // Session alternating hit / miss: survived 10 s, gone 400 s, survived 20 s, gone 500 s.
  const alternating = (config: CacheConfig = CONFIG) =>
    result(
      input([
        call({ id: "0", at: 0, uncached: 30000 }),
        call({ id: "1", at: 10, read: 30000 }),
        call({ id: "2", at: 410, uncached: 30010 }),
        call({ id: "3", at: 430, read: 30010 }),
        call({ id: "4", at: 930, uncached: 30010 }),
      ]),
      config,
    );

  it("reports longest survived, shortest gone, median and gap bands per harness and model", () => {
    const [group] = alternating().lifetimes;
    assert.ok(group);
    assert.equal(group.declaredLifetimeSeconds, null);
    assert.equal(group.harness, "claudeCode");
    assert.equal(group.model, "m");
    assert.deepEqual([group.survived, group.gone], [2, 2]);
    assert.equal(group.longestSurvivedSeconds, 20);
    assert.equal(group.shortestGoneSeconds, 400);
    assert.equal(group.sufficient, true);
    assert.equal(group.medianSeconds, 400);
    assert.deepEqual(group.bands.slice(0, 3), [
      { fromSeconds: 0, toSeconds: 60, survived: 2, gone: 0 },
      { fromSeconds: 60, toSeconds: 300, survived: 0, gone: 0 },
      { fromSeconds: 300, toSeconds: 900, survived: 0, gone: 2 },
    ]);
    assert.deepEqual(group.bands.at(-1), { fromSeconds: 86400, toSeconds: null, survived: 0, gone: 0 });
  });

  it("measures each declared lifetime apart, ascending, with no declared lifetime last", () => {
    const groups = result(
      input(
        [
          // Session s promises an hour: the cache survives 30 minutes.
          call({ id: "a", at: 0, uncached: 0, write: 30000, ttl: { "3600": 30000 } }),
          call({ id: "b", at: 1800, uncached: 0, read: 30000 }),
          // Session t promises 5 minutes: the cache is gone after 10.
          call({ id: "c", at: 0, uncached: 0, write: 30000, ttl: { "300": 30000 }, session: "t" }),
          call({ id: "d", at: 600, uncached: 0, write: 30000, ttl: { "300": 30000 }, session: "t" }),
          // Session u logs no lifetime.
          call({ id: "e", at: 0, uncached: 30000, session: "u" }),
          call({ id: "f", at: 10, read: 30000, session: "u" }),
        ],
        [],
        [session("s"), session("t"), session("u")],
      ),
    ).lifetimes;
    assert.deepEqual(
      groups.map((g) => [g.declaredLifetimeSeconds, g.survived, g.gone]),
      [
        [300, 0, 1],
        [3600, 1, 0],
        [null, 1, 0],
      ],
    );
  });

  it("shows insufficient data below the minimum observation count", () => {
    const [group] = alternating({ ...CONFIG, minLifetimeObservations: 5 }).lifetimes;
    assert.equal(group?.sufficient, false);
    assert.equal(group?.medianSeconds, null);
  });

  it("shows insufficient data without both survived and gone observations", () => {
    const [group] = result(
      input([
        call({ id: "0", at: 0, uncached: 30000 }),
        ...[1, 2, 3, 4, 5].map((i) => call({ id: `${i}`, at: i * 10, read: 30000 })),
      ]),
    ).lifetimes;
    assert.equal(group?.sufficient, false);
  });
});

describe("DECL-1 declared lifetime", () => {
  it("takes the largest non-zero lifetime of the most recent cache write, and carries it forward", () => {
    const c = byId(
      input([
        call({ id: "a", at: 0, uncached: 0, write: 30000, ttl: { "300": 100, "3600": 29900 } }),
        call({ id: "b", at: 10, uncached: 0, read: 30000 }),
        call({ id: "c", at: 20, uncached: 0, read: 30000 }),
        call({ id: "d", at: 30, uncached: 0, read: 30000, write: 50, ttl: { "300": 50, "3600": 0 } }),
        call({ id: "e", at: 40, uncached: 0, read: 30050 }),
      ]),
    );
    assert.deepEqual(
      ["a", "b", "c", "d", "e"].map((id) => c.get(id)?.declaredLifetimeSeconds),
      [null, 3600, 3600, 3600, 300],
    );
  });

  it("falls back to the configured lifetime for the harness and model", () => {
    const config = { ...CONFIG, declaredLifetimeSeconds: { ...CONFIG.declaredLifetimeSeconds, claudeCode: { m: 900 } } };
    const c = byId(input([call({ id: "a", at: 0, uncached: 30000 }), call({ id: "b", at: 10, read: 30000 })]), config);
    assert.equal(c.get("b")?.declaredLifetimeSeconds, 900);
  });

  it("summarizes declared lifetimes per model, leaving out first calls and keeping the latest declared one", () => {
    const declared = result(
      input([
        call({ id: "a", at: 0, uncached: 0, write: 30000, ttl: { "3600": 30000 } }),
        call({ id: "b", at: 10, uncached: 0, read: 30000 }),
        call({ id: "c", at: 20, uncached: 0, read: 30000, write: 50, ttl: { "300": 50 } }),
        call({ id: "d", at: 30, uncached: 0, read: 30050 }),
        call({ id: "e", at: 40, uncached: 0, write: 30000, session: "t" }),
        call({ id: "f", at: 50, uncached: 0, read: 30000, session: "t" }),
      ], [], [session("s"), session("t")]),
    ).declared;
    assert.deepEqual(declared, [
      {
        rule: "DECL-1",
        harness: "claudeCode",
        model: "m",
        modelSource: "logged",
        lifetimes: [
          { seconds: 300, calls: 1 },
          { seconds: 3600, calls: 2 },
          { seconds: null, calls: 1 },
        ],
        // "f" declares nothing (its session never logged a lifetime), so the latest declared one stays 300.
        latestSeconds: 300,
      },
    ]);
  });
});

describe("CAUSE-1 miss causes", () => {
  it("blames a model switch first", () => {
    const c = byId(input([call({ id: "a", at: 0, uncached: 30000 }), call({ id: "b", at: 9999, uncached: 30000, model: "x" })]));
    assert.deepEqual(c.get("b")?.cause, { rule: "CAUSE-1", cause: "modelSwitch", referenceLifetimeSeconds: null, referenceSource: null });
  });

  it("uses the declared lifetime when there is one: a miss within it is a premature loss", () => {
    const c = byId(
      input([
        call({ id: "a", at: 0, uncached: 0, write: 30000, ttl: { "3600": 30000 } }),
        call({ id: "b", at: 600, uncached: 30000 }),
        call({ id: "c", at: 5000, uncached: 30000 }),
      ]),
    );
    assert.deepEqual(c.get("b")?.cause, { rule: "CAUSE-1", cause: "prematureLoss", referenceLifetimeSeconds: 3600, referenceSource: "declared" });
    assert.equal(c.get("c")?.cause?.cause, "idleBeyondLifetime");
  });

  it("uses the observed median when nothing is declared", () => {
    const c = byId(
      input([
        call({ id: "0", at: 0, uncached: 30000 }),
        call({ id: "1", at: 10, read: 30000 }),
        call({ id: "2", at: 410, uncached: 30010 }),
        call({ id: "3", at: 430, read: 30010 }),
        call({ id: "4", at: 930, uncached: 30010 }),
      ]),
    );
    assert.deepEqual(c.get("2")?.cause, { rule: "CAUSE-1", cause: "prematureLoss", referenceLifetimeSeconds: 400, referenceSource: "observed" });
    assert.equal(c.get("4")?.cause?.cause, "idleBeyondLifetime");
  });

  it("falls back to the configured reference lifetime", () => {
    const c = byId(input([call({ id: "a", at: 0, uncached: 30000 }), call({ id: "b", at: 200, uncached: 30000 })]));
    assert.deepEqual(c.get("b")?.cause, { rule: "CAUSE-1", cause: "prematureLoss", referenceLifetimeSeconds: 300, referenceSource: "configured" });
  });
});

describe("cache analysis determinism (R-10)", () => {
  it("returns the same result regardless of input order", () => {
    const calls = [
      call({ id: "a", at: 0, uncached: 30000 }),
      call({ id: "b", at: 10, read: 30000, session: "t" }),
      call({ id: "c", at: 20, read: 30000 }),
      call({ id: "d", at: 500, uncached: 30010, session: "t" }),
    ];
    const sessions = [session("s"), session("t", "antigravity")];
    assert.deepEqual(result(input([...calls].reverse(), [], [...sessions].reverse())), result(input(calls, [], sessions)));
  });
});
