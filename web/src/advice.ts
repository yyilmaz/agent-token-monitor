// ADVICE-1 and WORKFLOW-1 in words (ADR 0017): the tag and the figures behind it on the Now view.
// Fixed English templates filled with the figures (R-04, R-11). Token load: the product cannot measure lost detail.

import type { AdviceOption, ContextState, OptionLoad, SessionAdvice, WorkflowProfile } from "../../src/core/analysis/advice.js";
import { h, sessionLink } from "./dom.js";
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
  freshStartUnknown: "too few sessions to know a typical fresh start",
  postCompactionUnknown: "too few compactions to know the size after one",
  summaryUnknown: "too few compactions with a logged summary size",
  remainingUnknown: "too few sessions of this size to know how long they go on",
};

export const TOKEN_LOAD_NOTE = "Compacting or starting fresh can discard details that still matter.";

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

/** Whether this advice entry has expandable WORKFLOW-1 or ADVICE-1 details. */
export function hasAdviceDetails(a: SessionAdvice): boolean {
  return a.advice !== null || a.workflow.contextState !== null;
}

/** The status badge for a session's ADVICE-1 or WORKFLOW-1 recommendation. */
export function adviceBadge(a: SessionAdvice): HTMLElement | null {
  if (a.advice === null) {
    if (a.workflow.contextState === null) return null;
    const [wText, wTone] = WORKFLOW_TAG[a.workflow.contextState];
    return h("span", { class: `badge ${wTone}`, title: `WORKFLOW-1 · ${workflowSentence(a.workflow)}` }, wText);
  }
  const [text, tone] = TAG[a.advice];
  return h("span", { class: `badge ${tone}`, title: `ADVICE-1 · ${adviceSentence(a)} ${TOKEN_LOAD_NOTE}` }, text);
}

/** The badge and one-line summary for a session, with a compact "Why?" trigger that opens the detail drawer (ADR 0017). */
export function adviceTag(a: SessionAdvice | null | undefined, onWhy?: (advice: SessionAdvice) => void): HTMLElement {
  if (a === null || a === undefined) return h("span", { class: "muted" }, "");
  const badge = adviceBadge(a);
  if (badge === null) {
    return h("span", { class: "muted", title: `ADVICE-1 · no advice: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}` }, "—");
  }
  const whyBtn =
    onWhy !== undefined && hasAdviceDetails(a)
      ? (() => {
          const btn = h("button", { type: "button", class: "btn btn-sm col-toggle advice-why-btn" }, "Why?");
          btn.addEventListener("click", () => onWhy(a));
          return btn;
        })()
      : null;

  return h(
    "div",
    { class: "advice-wrap" },
    h("div", { class: "d-flex flex-wrap align-items-center gap-2" }, badge, whyBtn),
    h("div", { class: "muted small mt-1 advice-summary" }, workflowSubtitle(a.workflow)),
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

/** The recommendation and expected saving in weighted token units (ADR 0017, R-51, R-60). */
export function adviceSentence(a: SessionAdvice): string {
  if (a.advice === null) return `No advice: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}.`;
  const [, compact, fresh] = a.options as readonly [OptionLoad, OptionLoad, OptionLoad];
  const recommendation = { keepGoing: "Keep going", compact: "Compact now", startFresh: "Start a new session" }[a.advice];
  return `${recommendation}. Expected saving vs. keeping going: ${f.compactTokens(a.saving)} weighted token units over ${a.horizonMessages} messages. ` +
    `Compacting uses ${f.compactTokens(compact.total)} units and a fresh session uses ${f.compactTokens(fresh.total)} units.`;
}

/** The figures behind the advice, rendered inside the detail drawer (R-17, R-63). */
export function adviceDetailsNodes(a: SessionAdvice, onNavigate?: () => void): HTMLElement[] {
  const w = a.workflow;
  const workflowNote = h(
    "p",
    { class: "muted small" },
    `${workflowSentence(w)} ` +
      `Started at ${f.compactTokens(w.firstContextTokens)} tokens, recent 3-turn growth ${f.compactTokens(w.recentGrowthTokens)} tokens` +
      (w.subagentCount > 0 ? `, subagents used ${f.compactTokens(w.subagentTokens)} tokens.` : "."),
  );
  if (a.advice === null) {
    if (w.contextState === null) return [];
    return [
      workflowNote,
      h("p", { class: "muted small mb-0" }, `Weighted token comparison (ADVICE-1) unavailable: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}.`),
    ];
  }
  const name: Readonly<Record<AdviceOption, string>> = { keepGoing: "Keep going", compact: "Compact", startFresh: "New session" };
  const { freshStart, postCompaction, summary, remaining } = a.figures;
  const evidenceLink = sessionLink(a.sessionId, "Session evidence");
  if (onNavigate !== undefined) evidenceLink.addEventListener("click", onNavigate);

  return [
    workflowNote,
    h(
      "p",
      { class: "muted small" },
      `Context now ${f.tokens(a.contextTokens)} tokens, cache ${a.warm ? "warm" : "cold"}. ` +
        `After compacting: ${f.tokens(postCompaction?.medianContextTokens ?? null)} (POSTCOMPACT-1, ${postCompaction?.compactions} compactions), ` +
        `summary ${f.tokens(summary?.medianTokens ?? null)} (SUMMARY-1, an estimate: the summarization request is not logged). ` +
        `A new session starts at ${f.tokens(freshStart?.medianContextTokens ?? null)} (FRESH-1). ` +
        `Sessions of this size usually send ${a.horizonMessages} more messages (REMAIN-1, ${remaining?.sessions} sessions).`,
    ),
    h(
      "div",
      { class: "table-responsive table-card mb-3", tabindex: "0" },
      h(
        "table",
        { class: "table table-sm align-middle text-nowrap small mb-0" },
        h("thead", {}, h("tr", {}, ["Option", "Initial units", "Units per message", `Units over ${a.horizonMessages} messages`, "Break-even"].map((t) => h("th", { scope: "col" }, t)))),
        h(
          "tbody",
          {},
          a.options.map((o) =>
            h(
              "tr",
              o.option === a.advice ? { class: "table-active fw-semibold" } : {},
              h("td", {}, name[o.option]),
              h("td", { class: "num" }, f.compactTokens(o.oneTime)),
              h("td", { class: "num" }, f.compactTokens(o.perMessage)),
              h("td", { class: "num" }, f.compactTokens(o.total)),
              h("td", { class: "num" }, o.option === "keepGoing" ? "" : o.breakEvenMessages === null ? "never" : `after ${o.breakEvenMessages}`),
            ),
          ),
        ),
      ),
    ),
    h("p", { class: "muted small" },
      `ADVICE-1 weights: cache read ×${a.weights.cacheRead}, cache write ×${a.weights.cacheWrite}, output ×${a.weights.output}. `,
      evidenceLink,
    ),
    h("p", { class: "muted small mb-0" }, TOKEN_LOAD_NOTE),
  ];
}
