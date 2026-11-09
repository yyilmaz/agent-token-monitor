// ADVICE-1 and WORKFLOW-1 in words (ADR 0017): the tag and the figures behind it on the Now view.
// Fixed English templates filled with the figures (R-04, R-11). Cost only: the product cannot measure lost detail.

import type { AdviceOption, ContextState, OptionCost, SessionAdvice, WorkflowProfile } from "../../src/core/analysis/advice.js";
import { h } from "./dom.js";
import * as f from "./format.js";

const TAG: Readonly<Record<AdviceOption, readonly [string, string]>> = {
  keepGoing: ["Keep going", "good"],
  compact: ["Compact now", "warn"],
  startFresh: ["Start fresh", "warn"],
};

const WORKFLOW_TAG: Readonly<Record<ContextState, readonly [string, string]>> = {
  compactActive: ["Stay in session · lean context", "good"],
  activeWorkingSet: ["Stay in session · active context", "good"],
  explorationHeavy: ["Delegate or compact · heavy exploration", "warn"],
  waitingOnSubagents: ["Stay in session · subagents running", "good"],
  coldLargeContext: ["Start fresh · cold cache", "warn"],
};

const UNKNOWN: Readonly<Record<NonNullable<SessionAdvice["unknownReason"]>, string>> = {
  modelUnknown: "the log records no model",
  contextUnknown: "the context size is not logged",
  unpricedModel: "this model has no price",
  writePriceUnknown: "the price table lists no cache-write price",
  freshStartUnknown: "too few sessions to know a typical fresh start",
  postCompactionUnknown: "too few compactions to know the size after one",
  summaryUnknown: "too few compactions with a logged summary size",
  remainingUnknown: "too few sessions of this size to know how long they go on",
};

export const COST_ONLY = "Compares cost only: a summary or a new session loses detail, which the logs cannot show.";

/** Short one-line summary shown directly below the badge. */
function workflowSubtitle(w: WorkflowProfile): string {
  const turnText =
    w.turns === 0
      ? "just compacted · 0 turns in active window"
      : `${w.turns} ${w.turns === 1 ? "turn" : "turns"} (${w.editTurns} edit, ${w.exploreTurns} explore)`;
  const parts: string[] = [turnText];
  if (w.subagentCount > 0) {
    const activeNote = w.activeSubagentCount > 0 ? ` (${w.activeSubagentCount} active)` : "";
    parts.push(`${w.subagentCount} ${w.subagentCount === 1 ? "subagent" : "subagents"}${activeNote}`);
  }
  if (w.splitBreakEvenSteps !== null) {
    parts.push(`split subtasks ≥ ${w.splitBreakEvenSteps} ${w.splitBreakEvenSteps === 1 ? "step" : "steps"}`);
  }
  return parts.join(" · ");
}

/** The badge for a session; falls back to WORKFLOW-1 when price-based advice is unknown, and expandable details one level deeper. */
export function adviceTag(a: SessionAdvice | null | undefined, decimals: number): HTMLElement {
  if (a === null || a === undefined) return h("span", { class: "muted" }, "");
  if (a.advice === null) {
    if (a.workflow.contextState !== null) {
      const [wText, wTone] = WORKFLOW_TAG[a.workflow.contextState];
      return h(
        "div",
        { class: "advice-wrap" },
        h(
          "span",
          {
            class: `badge ${wTone}`,
            title: `WORKFLOW-1 · ${workflowSentence(a.workflow)}`,
          },
          wText,
        ),
        h("div", { class: "advice-sub" }, workflowSubtitle(a.workflow)),
        adviceDetails(a, decimals),
      );
    }
    return h("span", { class: "muted", title: `ADVICE-1 · no advice: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}` }, "—");
  }
  const [text, tone] = TAG[a.advice];
  return h(
    "div",
    { class: "advice-wrap" },
    h("span", { class: `badge ${tone}`, title: `ADVICE-1 · ${adviceSentence(a, decimals)} ${COST_ONLY}` }, text),
    h("div", { class: "advice-sub" }, workflowSubtitle(a.workflow)),
    adviceDetails(a, decimals),
  );
}

/** One sentence explaining the WORKFLOW-1 context state and subagent break-even. */
export function workflowSentence(w: WorkflowProfile): string {
  const split =
    w.splitBreakEvenSteps === null
      ? ""
      : ` Independent subtasks of ${w.splitBreakEvenSteps}+ steps use fewer context tokens in a subagent.`;
  switch (w.contextState) {
    case "compactActive":
      return `Context is still lean (${w.turns} turns: ${w.editTurns} edit, ${w.exploreTurns} explore). Keep working in this session.${split}`;
    case "activeWorkingSet":
      return `Warm active working set (${w.turns} turns: ${w.editTurns} edit, ${w.exploreTurns} explore). Growing context here is productive while the cache stays warm.${split}`;
    case "explorationHeavy":
      return `Exploration-heavy context (${w.turns} turns: ${w.exploreTurns} explore vs. ${w.editTurns} edit). Delegate broad searches to subagents or compact at the next phase boundary.${split}`;
    case "waitingOnSubagents":
      return `Waiting on ${w.activeSubagentCount} active ${w.activeSubagentCount === 1 ? "subagent" : "subagents"} (${w.turns} turns in main session). Stay in this session while subagents finish and return results.${split}`;
    case "coldLargeContext":
      return `Large context with a cold cache (${w.turns} turns). Avoid compacting on a cold cache; start a fresh session with a handoff summary if changing tasks.${split}`;
    case null:
      return `${w.turns} turns (${w.editTurns} edit, ${w.exploreTurns} explore).`;
  }
}

/** One sentence: what to do and why, in money. */
export function adviceSentence(a: SessionAdvice, decimals: number): string {
  if (a.advice === null) return `No advice: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}.`;
  const [, compact, fresh] = a.options as readonly [OptionCost, OptionCost, OptionCost];
  const usual = a.horizonMessages === null ? "" : `you usually send about ${a.horizonMessages} more`;
  const money = (m: string | null) => (m === null ? "unknown" : f.money(m, decimals, a.currency));
  const after = (o: OptionCost) => (o.breakEvenMessages === null ? "never" : `after ${o.breakEvenMessages} more messages`);
  // The other two options' totals ride along, so a close call between compacting and a new session shows.
  const over = `over your usual ${a.horizonMessages} messages`;
  switch (a.advice) {
    case "keepGoing":
      return `Keep going. Compacting pays off only ${after(compact)}, a new session ${after(fresh)}; ${usual}.`;
    case "compact":
      return `Compact now${a.warm ? ", while the cache is warm" : ""}. Saves about ${money(a.saving)} ${over}: compacting costs ${money(compact.total)}, a new session ${money(fresh.total)}.`;
    case "startFresh":
      return a.warm
        ? `Start a new session. Saves about ${money(a.saving)} ${over}: a new session costs ${money(fresh.total)}, compacting ${money(compact.total)}.`
        : `Start a new session. The cache is cold: compacting now costs ${money(compact.oneTime)}, a new session ${money(fresh.oneTime)}.`;
  }
}

/** The figures behind the advice, one level deeper (R-17, R-63). */
export function adviceDetails(a: SessionAdvice, decimals: number): HTMLElement | null {
  const w = a.workflow;
  const workflowNote = h(
    "p",
    { class: "muted small" },
    `${workflowSentence(w)} ` +
      `Started at ${f.compactTokens(w.firstContextTokens)} tokens, recent 3-turn growth ${f.compactTokens(w.recentGrowthTokens)} tokens` +
      (w.subagentCount > 0 ? `, subagents used ${f.compactTokens(w.subagentTokens)} tokens.` : "."),
  );
  if (a.advice === null) {
    if (w.contextState === null) return null;
    return h(
      "details",
      {},
      h("summary", { class: "small" }, "Why?"),
      workflowNote,
      h("p", { class: "muted small" }, `List-price comparison (ADVICE-1) unavailable: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}.`),
    );
  }
  const money = (m: string) => f.money(m, decimals, a.currency);
  const name: Readonly<Record<AdviceOption, string>> = { keepGoing: "Keep going", compact: "Compact", startFresh: "New session" };
  const { freshStart, postCompaction, summary, remaining } = a.figures;
  return h(
    "details",
    {},
    h("summary", { class: "small" }, "Why?"),
    workflowNote,
    h(
      "p",
      { class: "muted small" },
      `Context now ${f.tokens(a.contextTokens)} tokens, cache ${a.warm ? "warm" : "cold"}, writes priced at the ${f.duration(a.writeLifetimeSeconds)} lifetime. ` +
        `After compacting: ${f.tokens(postCompaction?.medianContextTokens ?? null)} (POSTCOMPACT-1, ${postCompaction?.compactions} compactions), ` +
        `summary ${f.tokens(summary?.medianTokens ?? null)} (SUMMARY-1, an estimate: the summarization request is not logged). ` +
        `A new session starts at ${f.tokens(freshStart?.medianContextTokens ?? null)} (FRESH-1). ` +
        `Sessions of this size usually send ${a.horizonMessages} more messages (REMAIN-1, ${remaining?.sessions} sessions).`,
    ),
    h(
      "table",
      { class: "small" },
      h("thead", {}, h("tr", {}, ["Option", "Now", "Per message", `Over ${a.horizonMessages} messages`, "Pays off"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        a.options.map((o) =>
          h(
            "tr",
            o.option === a.advice ? { class: "chosen" } : {},
            h("td", {}, name[o.option]),
            h("td", { class: "num" }, money(o.oneTime)),
            h("td", { class: "num" }, money(o.perMessage)),
            h("td", { class: "num" }, money(o.total)),
            h("td", { class: "num" }, o.option === "keepGoing" ? "" : o.breakEvenMessages === null ? "never" : `after ${o.breakEvenMessages}`),
          ),
        ),
      ),
    ),
    h("p", { class: "muted small" }, `${COST_ONLY} ${a.label}`),
  );
}
