// Pins FRESH-1, TASK-1, STEPS-1, POSTCOMPACT-1, SUMMARY-1, ADVICE-1 and WORKFLOW-1 with the acceptance scenarios of ADR 0017
// (R-51, R-60, R-62, R-63). Synthetic figures only (R-18, R-70).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AdviceConfig, type SessionAdvice, sessionAdvice } from "../../../src/core/analysis/advice.js";
import { analyzeCache, type CacheConfig } from "../../../src/core/analysis/cache.js";
import { openSessions } from "../../../src/core/analysis/live.js";
import type { Config } from "../../../src/core/config/config.js";
import type { Call, Event, HarnessId, Session, StepClass } from "../../../src/core/model/index.js";

const CACHE: CacheConfig = {
  fullMissMinContextTokens: 20000,
  hitToleranceTokens: 1024,
  survivedMinCacheReadShare: 0.75,
  lifetimeBandEdgesSeconds: [60],
  minLifetimeObservations: 4,
  declaredLifetimeSeconds: { claudeCode: {}, antigravity: {}, codex: {}, opencode: {} },
  referenceLifetimeSeconds: { claudeCode: 300, antigravity: 300, codex: 300, opencode: 300 },
};

const RULES: Config["rules"] = {
  freshSession: { minSessions: 5 },
  sessionAdvice: { minCompactions: 5, minUserTurns: 5, leanContextTokens: 50000 },
};

const T = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (seconds: number) => T - seconds * 1000;
const WARM = 60;
const COLD = 4000;
let line = 0;
const src = () => [{ logRoot: "r:0", file: "f", line: (line += 1) }];

function call(
  id: string,
  sessionId: string,
  timestamp: number,
  context: number,
  model: string | null = "m",
  toolNames: readonly string[] = [],
  shellClasses: readonly StepClass[] = [],
): Call {
  return {
    id, sessionId, timestamp, model, kind: "turn",
    inputUncached: 0, cacheRead: context, cacheWrite: 0, output: 10, reasoning: null,
    cacheWriteByTtlSeconds: null, toolNames, shellClasses, sources: src(),
  };
}

const session = (id: string, harness: HarnessId = "claudeCode", parent: string | null = null): Session => ({
  id, harness, nativeId: id, parentSessionId: parent, isSubagent: parent !== null, spawnedBySessionId: null,
  title: null, projectPath: "/p", sources: [],
});

const event = (sessionId: string, timestamp: number, type: "userTurn" | "compaction", postTokens: number | null = null): Event => ({
  id: `${sessionId}:${type}:${timestamp}`,
  sessionId,
  timestamp,
  type,
  childSessionId: null,
  compaction: type === "compaction" ? { trigger: "manual", preTokens: 160000, postTokens } : null,
  sources: src(),
});

interface History {
  readonly harness: HarnessId;
  readonly model: string;
  /** FRESH-1: first context of every past session. */
  readonly F: number;
  /** STEPS-1: turn calls per user message. */
  readonly H: number;
  /** User messages per past session, so TASK-1 = requests × H. */
  readonly requests: number;
  /** POSTCOMPACT-1 and SUMMARY-1; omitted for a harness that logs no compaction figures. */
  readonly P?: number;
  readonly S?: number;
  readonly sessions?: number;
  readonly userTurns?: boolean;
}

const CLAUDE: History = { harness: "claudeCode", model: "m", F: 80000, H: 5, requests: 16, P: 95000, S: 20000 };
const ANTIGRAVITY: History = { harness: "antigravity", model: "m-ag", F: 20000, H: 8, requests: 4 };
const CODEX: History = { harness: "codex", model: "m-cx", F: 15000, H: 10, requests: 4 };

/** Past sessions whose medians are exactly F, H, requests × H, P and S; compaction halfway through each. */
function history(h: History): { sessions: Session[]; calls: Call[]; events: Event[] } {
  const sessions: Session[] = [];
  const calls: Call[] = [];
  const events: Event[] = [];
  const half = Math.floor(h.requests / 2);
  for (let n = 0; n < (h.sessions ?? 5); n++) {
    const id = `${h.harness}-h${n}`;
    const start = ago(30 * 86400 + n * 86400);
    sessions.push(session(id, h.harness));
    for (let r = 0; r < h.requests; r++) {
      const at = start + r * 100_000;
      if (h.P !== undefined && r === half) events.push(event(id, at - 50_000, "compaction", h.S ?? null));
      if (h.userTurns !== false) events.push(event(id, at, "userTurn"));
      const base = h.P !== undefined && r >= half ? h.P : h.F;
      for (let i = 0; i < h.H; i++) calls.push(call(`${id}r${r}s${i}`, id, at + i * 1000, base + i * 100, h.model));
    }
  }
  return { sessions, calls, events };
}

interface Live {
  readonly history?: History;
  /** History in a different model than the open session. */
  readonly model?: string | null;
  readonly C: number;
  readonly idle: number;
  readonly activeSubagents?: number;
  readonly tools?: readonly (readonly [readonly string[], readonly StepClass[]])[];
  readonly compactedSecondsAgo?: number;
}

function run(spec: Live) {
  const h = spec.history ?? CLAUDE;
  const past = history(h);
  const model = spec.model === undefined ? h.model : spec.model;
  const sessions = [...past.sessions, session("live", h.harness)];
  const events = [...past.events];
  const calls = [...past.calls];
  // The open session: one user message, H steps from F up to C; the last step is `idle` seconds ago.
  if (h.userTurns !== false) events.push(event("live", ago(spec.idle + 600), "userTurn"));
  const tools = spec.tools ?? [];
  for (let i = 0; i < h.H; i++) {
    const last = i === h.H - 1;
    const [names, shells] = tools[i] ?? [[], []];
    calls.push(call(`live${i}`, "live", last ? ago(spec.idle) : ago(spec.idle + 500 - i), last ? spec.C : h.F + i * 1000, model, names, shells));
  }
  if (spec.compactedSecondsAgo !== undefined) events.push(event("live", ago(spec.compactedSecondsAgo), "compaction", 8000));
  for (let n = 0; n < (spec.activeSubagents ?? 0); n++) {
    const id = `sub${n}`;
    sessions.push(session(id, h.harness, "live"));
    calls.push(call(`${id}c`, id, ago(15), 30000, model));
  }
  const data = { sessions, calls, events };
  const config = { cache: CACHE, models: { assumed: {} }, liveView: { openWithinSeconds: 86400 }, rules: RULES };
  const cache = analyzeCache(data, config);
  const open = openSessions(data, cache, config, T);
  return sessionAdvice(data, cache, open, config satisfies AdviceConfig, T);
}

const advise = (spec: Live): SessionAdvice => {
  const a = run(spec).advice.find((x) => x.sessionId === "live");
  assert.ok(a !== undefined, "the open session has advice");
  return a;
};

/** Badge-level outcome: verdict, new-task advice, same-task advice. */
const outcome = (a: SessionAdvice) => [a.verdict, a.newTask?.advice ?? null, a.sameTask?.advice ?? null];
const share = (value: number | null | undefined) => (value == null ? null : Math.round(value * 1000) / 10);

describe("history figures (ADR 0017)", () => {
  const result = run({ C: 175000, idle: WARM });

  it("FRESH-1: the typical first context of top-level sessions", () => {
    assert.deepEqual(result.freshStarts.map((f) => [f.harness, f.model, f.sessions, f.medianContextTokens]), [["claudeCode", "m", 6, 80000]]);
  });

  it("TASK-1: the typical number of turn calls per session, over the same sessions", () => {
    // Five past sessions of 16 × 5 steps and the open one with 5: lower median of [5, 80, 80, 80, 80, 80].
    assert.deepEqual(result.tasks.map((t) => [t.model, t.sessions, t.medianSteps]), [["m", 6, 80]]);
  });

  it("STEPS-1: turn calls from each user message to the next", () => {
    assert.deepEqual(result.steps.map((s) => [s.model, s.userTurns, s.medianSteps]), [["m", 81, 5]]);
  });

  it("POSTCOMPACT-1 and SUMMARY-1: the first context after each compaction and the logged summary size", () => {
    assert.deepEqual(result.postCompactions.map((p) => [p.compactions, p.medianContextTokens]), [[5, 95000]]);
    assert.deepEqual(result.summaries.map((s) => [s.compactions, s.medianTokens]), [[5, 20000]]);
  });

  it("are unknown below the minimum count (R-16)", () => {
    const few = run({ history: { ...CLAUDE, sessions: 3 }, C: 175000, idle: WARM });
    assert.deepEqual(few.postCompactions.map((p) => [p.compactions, p.medianContextTokens]), [[3, null]]);
    assert.deepEqual(few.freshStarts.map((f) => [f.sessions, f.medianContextTokens]), [[4, null]]);
    assert.deepEqual(few.tasks.map((t) => [t.sessions, t.medianSteps]), [[4, null]]);
  });
});

/** Break-even per case: [steps, messages]. */
const breakEven = (a: SessionAdvice) => [
  [a.newTask?.option?.breakEvenSteps ?? null, a.newTask?.breakEvenMessages ?? null],
  [a.sameTask?.option?.breakEvenSteps ?? null, a.sameTask?.breakEvenMessages ?? null],
];

describe("ADVICE-1 acceptance scenarios (ADR 0017)", () => {
  it("A1: a running subagent means wait, whatever the comparison would say", () => {
    const a = advise({ C: 252000, idle: WARM, activeSubagents: 1 });
    assert.deepEqual(outcome(a), ["wait", null, null]);
    assert.equal(a.activeSubagentCount, 1);
  });

  it("A2: 252K warm: a new session pays back after ~2 messages, compacting after ~2", () => {
    const a = advise({ C: 252000, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "startFresh", "compact"]);
    assert.deepEqual(breakEven(a), [[6, 2], [10, 2]]);
    assert.deepEqual([a.taskSteps, a.taskMessages, a.stepsPerRequest], [80, 16, 5]);
    assert.deepEqual([a.keep?.total, a.newTask?.option?.total, a.sameTask?.option?.total], [2016000, 740000, 910200]);
    assert.equal(share(a.newTask?.savingShare), 63.3);
  });

  it("A3: 175K warm: ~3 messages for a new session, ~4 for compacting", () => {
    const a = advise({ C: 175000, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "startFresh", "compact"]);
    assert.deepEqual(breakEven(a), [[11, 3], [18, 4]]);
  });

  it("A4: 100K warm: a new session pays back after ~10 messages; compacting only after ~54, beyond a typical task", () => {
    const a = advise({ C: 100000, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "startFresh", "keepGoing"]);
    assert.deepEqual(breakEven(a), [[50, 10], [270, 54]]);
  });

  it("A5–A7: the boundary is a strict saving over a typical task; a tie keeps going", () => {
    const below = advise({ C: 92400, idle: WARM });
    assert.deepEqual(outcome(below), ["compare", "keepGoing", "keepGoing"]);
    assert.deepEqual(breakEven(below), [[81, 17], [null, null]]);
    const tie = advise({ C: 92500, idle: WARM });
    assert.deepEqual([outcome(tie), tie.newTask?.saving, tie.newTask?.option?.breakEvenSteps], [["compare", "keepGoing", "keepGoing"], 0, 80]);
    const above = advise({ C: 92600, idle: WARM });
    assert.deepEqual([outcome(above), above.newTask?.saving, above.newTask?.breakEvenMessages], [["compare", "startFresh", "keepGoing"], 800, 16]);
  });

  it("A8: a context above the lean limit but below a fresh start never pays back", () => {
    const a = advise({ C: 60000, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "keepGoing", "keepGoing"]);
    assert.deepEqual(breakEven(a), [[null, null], [null, null]]);
  });

  it("A9: a lean context keeps going without a comparison", () => {
    assert.deepEqual(outcome(advise({ C: 30000, idle: WARM })), ["lean", null, null]);
  });

  it("A10: subagent rows get no advice", () => {
    const result = run({ C: 252000, idle: WARM, activeSubagents: 1 });
    assert.deepEqual(result.advice.map((a) => a.sessionId), ["live"]);
  });

  it("B1: Antigravity compares a fresh session even without compaction figures", () => {
    const a = advise({ history: ANTIGRAVITY, C: 75600, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "startFresh", "keepGoing"]);
    assert.deepEqual([a.newTask?.option?.breakEvenSteps, a.newTask?.breakEvenMessages, a.taskSteps], [5, 1, 32]);
    assert.deepEqual([a.sameTask?.unknownReason, a.sameTask?.option], ["postCompactionUnknown", null]);
  });

  it("B2: a small cold context is lean", () => {
    assert.deepEqual(outcome(advise({ history: ANTIGRAVITY, C: 25300, idle: COLD })), ["lean", null, null]);
  });

  it("B3: a large cold context counts the rebuild, so a new session is cheaper at once", () => {
    const a = advise({ history: ANTIGRAVITY, C: 135900, idle: COLD });
    assert.deepEqual([a.warm, ...outcome(a)], [false, "compare", "startFresh", "keepGoing"]);
    assert.deepEqual([a.keep?.oneTime, a.newTask?.option?.breakEvenSteps, a.newTask?.breakEvenMessages], [169875, 0, 0]);
  });

  it("C1: Codex pays back within the first message", () => {
    const a = advise({ history: CODEX, C: 246400, idle: WARM });
    assert.deepEqual(outcome(a), ["compare", "startFresh", "keepGoing"]);
    assert.deepEqual([a.stepsPerRequest, a.taskSteps, a.newTask?.option?.breakEvenSteps, a.newTask?.breakEvenMessages], [10, 40, 1, 1]);
  });

  it("D1: an unknown model gives no advice", () => {
    const a = advise({ model: null, C: 93600, idle: WARM });
    assert.deepEqual([a.verdict, a.unknownReason], ["unknown", "modelUnknown"]);
  });

  it("D2: too few sessions of the model leave the fresh start unknown", () => {
    const a = advise({ model: "new-model", C: 93600, idle: WARM });
    assert.deepEqual([a.verdict, a.unknownReason], ["unknown", "freshStartUnknown"]);
  });

  it("D3: too few user turns leave the steps per request unknown", () => {
    const a = advise({ history: { ...CLAUDE, userTurns: false }, C: 93600, idle: WARM });
    assert.deepEqual([a.verdict, a.unknownReason], ["unknown", "stepsUnknown"]);
  });

  it("D4: wait comes before unknown figures", () => {
    const a = advise({ model: "new-model", C: 93600, idle: WARM, activeSubagents: 1 });
    assert.deepEqual([a.verdict, a.unknownReason], ["wait", null]);
  });
});

describe("ADVICE-1 arithmetic", () => {
  it("D5: never recommends a change that saves nothing, even with zero weights", () => {
    const config = { cache: CACHE, models: { assumed: {} }, liveView: { openWithinSeconds: 86400 }, rules: { ...RULES, sessionAdvice: { ...RULES.sessionAdvice, weights: { cacheRead: 0, cacheWrite: 0, inputUncached: 1, output: 0 } } } };
    const past = history(CLAUDE);
    const data = {
      sessions: [...past.sessions, session("live")],
      calls: [...past.calls, call("z1", "live", ago(120), 80000), call("z2", "live", ago(WARM), 175000)],
      events: [...past.events, event("live", ago(200), "userTurn")],
    };
    const cache = analyzeCache(data, config);
    const [b] = sessionAdvice(data, cache, openSessions(data, cache, config, T), config, T).advice;
    assert.deepEqual([b?.keep?.total, b?.newTask?.saving, b?.newTask?.savingShare, b?.newTask?.advice], [0, 0, null, "keepGoing"]);
    assert.equal(b?.newTask?.option?.breakEvenSteps, 0);
  });
});

describe("WORKFLOW-1 (detail only)", () => {
  it("counts STEP-1 classes from named tools and shell calls", () => {
    const a = advise({
      C: 252000,
      idle: WARM,
      tools: [[["Read"], []], [["Bash"], ["explore"]], [["Bash"], ["edit"]], [["Bash"], ["other"]], [["Read", "Edit"], []]],
    });
    assert.deepEqual([a.workflow.turns, a.workflow.editTurns, a.workflow.exploreTurns, a.workflow.otherTurns], [5, 2, 2, 1]);
    assert.equal(a.workflow.explorationHeavy, false);
  });

  it("flags exploration-heavy growth and the split break-even, without changing the verdict", () => {
    const explore: readonly [readonly string[], readonly StepClass[]] = [["Bash"], ["explore"]];
    const a = advise({ C: 200000, idle: WARM, tools: [explore, explore, explore, explore] });
    assert.equal(a.workflow.explorationHeavy, true);
    // floor(2 × 200,000 ÷ (200,000 − 80,000)) + 1 = 4.
    assert.equal(a.workflow.splitBreakEvenSteps, 4);
    assert.deepEqual(outcome(a), ["compare", "startFresh", "compact"]);
  });

  it("resets the active window after a compaction", () => {
    const a = advise({ C: 200000, idle: WARM, compactedSecondsAgo: 10 });
    assert.deepEqual([a.workflow.turns, a.workflow.splitBreakEvenSteps, a.workflow.explorationHeavy], [0, null, false]);
  });

  it("computes weighted step load across the session", () => {
    const a = advise({ C: 30000, idle: WARM });
    // Steps at 80,000..83,000 then 30,000 cache read (×0.1) plus 10 output (×5) each.
    assert.equal(a.workflow.sessionWeightedTokens, 8000 + 8100 + 8200 + 8300 + 3000 + 5 * 50);
  });
});
