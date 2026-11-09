// Pins USE-1 usage totals and LIVE-1 open sessions of ADR 0013 (R-33, R-16, R-51a).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeCache, type CacheConfig } from "../../../src/core/analysis/cache.js";
import { openSessions, sessionTree } from "../../../src/core/analysis/live.js";
import { dayIn, priceCalls, usageTotals } from "../../../src/core/analysis/usage.js";
import type { Call, Session } from "../../../src/core/model/index.js";
import { priceTable } from "../../../src/core/pricing/price.js";

const CACHE: CacheConfig = {
  fullMissMinContextTokens: 20000,
  hitToleranceTokens: 1024,
  survivedMinCacheReadShare: 0.75,
  lifetimeBandEdgesSeconds: [60],
  minLifetimeObservations: 4,
  declaredLifetimeSeconds: { claudeCode: {}, antigravity: {}, codex: {}, opencode: {} },
  referenceLifetimeSeconds: { claudeCode: 300, antigravity: 600, codex: 300, opencode: 300 },
};

const TABLE = priceTable({
  currency: "USD",
  displayDecimals: 2,
  models: {
    m: {
      effectiveDate: "2026-10-01",
      tiers: [{ minContextTokens: 0, inputPerMillionTokens: 1, outputPerMillionTokens: 2, cacheReadPerMillionTokens: 0.1, cacheWritePerMillionTokensByTtlSeconds: { "300": 1.25 } }],
    },
  },
});

let line = 0;
function call(id: string, sessionId: string, iso: string, spec: Partial<Call> = {}): Call {
  line += 1;
  return {
    id,
    sessionId,
    timestamp: Date.parse(iso),
    model: "m",
    kind: "turn",
    inputUncached: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: null,
    cacheWriteByTtlSeconds: null,
    toolNames: [],
    sources: [{ logRoot: "r:0", file: "f", line }],
    ...spec,
  };
}

const session = (id: string, harness: Session["harness"], projectPath: string | null, parent: string | null = null): Session => ({
  id,
  harness,
  nativeId: id,
  parentSessionId: parent,
  isSubagent: parent !== null,
  spawnedBySessionId: null,
  title: null,
  projectPath,
  sources: [],
});

describe("USE-1 usage totals", () => {
  const sessions = [session("s1", "claudeCode", "/work/a"), session("s2", "antigravity", null)];
  const calls = [
    call("c1", "s1", "2026-10-01T20:00:00.000Z"),
    call("c2", "s1", "2026-10-01T22:30:00.000Z", { reasoning: 4 }),
    call("c3", "s1", "2026-10-01T22:40:00.000Z", { kind: "compaction", inputUncached: null, cacheRead: null, cacheWrite: null, output: null }),
    call("g1", "s2", "2026-10-31T23:59:59.000Z", { model: null }),
  ];
  const priced = priceCalls(calls, sessions, { models: { assumed: {} } }, TABLE);

  it("assigns days in the configured time zone", () => {
    assert.equal(dayIn(Date.parse("2026-10-01T22:30:00.000Z"), "UTC"), "2026-10-01");
    assert.equal(dayIn(Date.parse("2026-10-01T22:30:00.000Z"), "Europe/Istanbul"), "2026-10-02");
    assert.deepEqual(
      usageTotals(priced, "day", "Europe/Istanbul", TABLE).map((p) => [p.period, p.total.calls]),
      [["2026-10-01", 1], ["2026-10-02", 2], ["2026-11-01", 1]],
    );
    assert.deepEqual(
      usageTotals(priced, "month", "UTC", TABLE).map((p) => [p.period, p.total.calls]),
      [["2026-10", 4]],
    );
  });

  it("sums each token field and counts the calls where it is unknown (R-16)", () => {
    const [month] = usageTotals(priced, "month", "UTC", TABLE);
    assert.deepEqual(month?.total.inputUncached, { total: 300, unknownCalls: 1 });
    assert.deepEqual(month?.total.reasoning, { total: 4, unknownCalls: 3 });
    assert.equal(month?.total.cost.pricedCalls, 2);
    assert.deepEqual(month?.total.cost.unknownCalls, { unpricedModel: 1, unknownTokens: 1, unknownWritePrice: 0 });
    assert.equal(month?.total.cost.known.total, "0.000240000000");
  });

  it("splits by harness, effective model and project, with unknown kept apart", () => {
    const [month] = usageTotals(priced, "month", "UTC", TABLE);
    assert.deepEqual(month?.byHarness.map((s) => [s.harness, s.figures.calls]), [["antigravity", 1], ["claudeCode", 3]]);
    assert.deepEqual(month?.byModel.map((s) => [s.harness, s.model, s.figures.calls]), [["antigravity", null, 1], ["claudeCode", "m", 3]]);
    assert.deepEqual(month?.byProject.map((s) => [s.project, s.figures.calls]), [["/work/a", 3], [null, 1]]);
    assert.ok(month?.rule === "USE-1");
  });

  it("totals per session", () => {
    assert.deepEqual(usageTotals(priced, "session", "UTC", TABLE).map((p) => [p.period, p.total.calls]), [["s1", 3], ["s2", 1]]);
  });
});

describe("LIVE-1 open sessions", () => {
  const sessions = [
    session("warm", "claudeCode", "/w"),
    session("cold", "antigravity", null),
    session("lost", "claudeCode", "/l"),
    session("old", "claudeCode", "/o"),
    session("child", "claudeCode", "/w", "warm"),
  ];
  const T = "2026-10-01T12:00:00.000Z";
  const at = (secondsBefore: number) => new Date(Date.parse(T) - secondsBefore * 1000).toISOString();
  const calls = [
    call("w1", "warm", at(400), { cacheWrite: 30000, cacheWriteByTtlSeconds: { "3600": 30000 } }),
    call("w2", "warm", at(100), { cacheRead: 30100, cacheWrite: 100, cacheWriteByTtlSeconds: { "300": 100 } }),
    call("c1", "cold", at(900), { model: null }),
    call("l1", "lost", at(200), { inputUncached: 40000 }),
    call("l2", "lost", at(60), { inputUncached: 40100 }),
    call("o1", "old", at(4000)),
    call("k1", "child", at(30)),
  ];
  const data = { sessions, calls, events: [] };
  const cache = analyzeCache(data, { cache: CACHE, models: { assumed: {} } });
  const open = openSessions(data, cache, { liveView: { openWithinSeconds: 1800 }, cache: CACHE }, Date.parse(T));
  const byId = new Map(open.map((s) => [s.sessionId, s]));

  it("lists sessions whose last call is within the window, newest first", () => {
    assert.deepEqual(open.map((s) => s.sessionId), ["child", "lost", "warm", "cold"]);
    assert.equal(byId.get("child")?.parentSessionId, "warm");
  });

  it("is warm within the declared lifetime of the last write, and names its source", () => {
    const warm = byId.get("warm");
    assert.equal(warm?.cacheStatus, "warm");
    assert.deepEqual([warm?.referenceLifetimeSeconds, warm?.referenceSource], [300, "declared"]);
    assert.equal(warm?.contextTokens, 30300);
    assert.equal(warm?.secondsSinceLastCall, 100);
  });

  it("is probably cold past the configured reference lifetime when nothing is declared", () => {
    const cold = byId.get("cold");
    assert.equal(cold?.cacheStatus, "probablyCold");
    assert.deepEqual([cold?.referenceLifetimeSeconds, cold?.referenceSource], [600, "configured"]);
  });

  it("says when the last call lost the cache (LOSS-1)", () => {
    assert.equal(byId.get("lost")?.cacheStatus, "missedOnLastCall");
  });
});

describe("TREE-1 session tree", () => {
  const T = Date.parse("2026-10-01T12:00:00.000Z");
  const at = (secondsBefore: number) => new Date(T - secondsBefore * 1000).toISOString();
  const side = (id: string, starter: string): Session => ({ ...session(id, "claudeCode", "/w"), spawnedBySessionId: starter });
  const sessions = [
    session("main", "claudeCode", "/w"),
    side("sideA", "main"),
    side("sideB", "main"),
    session("sub", "claudeCode", "/w", "sideA"),
    session("alone", "claudeCode", "/x"),
    session("idle", "claudeCode", "/y"),
  ];
  const calls = [
    call("m1", "main", at(5000)),
    call("a1", "sideA", at(300)),
    call("b1", "sideB", at(60)),
    call("s1", "sub", at(30)),
    call("x1", "alone", at(100)),
    call("i1", "idle", at(5000)),
  ];
  const data = { sessions, calls, events: [] };
  const cache = analyzeCache(data, { cache: CACHE, models: { assumed: {} } });
  const rows = sessionTree(sessions, openSessions(data, cache, { liveView: { openWithinSeconds: 1800 }, cache: CACHE }, T));

  it("puts side sessions and subagents under their starter, newest subtree first", () => {
    assert.deepEqual(rows.map((r) => [r.sessionId, r.depth, r.relation]), [
      ["main", 0, "root"],
      ["sideA", 1, "sideSession"],
      ["sub", 2, "subagent"],
      ["sideB", 1, "sideSession"],
      ["alone", 0, "root"],
    ]);
  });

  it("shows a quiet starter as waiting while a session under it is open, and leaves other quiet sessions out", () => {
    assert.equal(rows.find((r) => r.sessionId === "main")?.open, null);
    assert.notEqual(rows.find((r) => r.sessionId === "sideB")?.open, null);
    assert.ok(!rows.some((r) => r.sessionId === "idle"));
  });
});
