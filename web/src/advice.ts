// ADVICE-1 and WORKFLOW-1 in words (ADR 0017): the badges and the figures behind them on the Now view.
// Fixed English templates filled with the figures (R-04, R-11). Token load only: the product cannot measure lost detail.

import type { AdviceCase, AdviceUnknownReason, OptionLoad, SessionAdvice, WorkflowProfile } from "../../src/core/analysis/advice.js";
import { h, sessionLink } from "./dom.js";
import * as f from "./format.js";

const UNKNOWN: Readonly<Record<AdviceUnknownReason, string>> = {
  modelUnknown: "the log records no model",
  contextUnknown: "the context size is not logged",
  freshStartUnknown: "too few sessions of this model to know a typical fresh start (FRESH-1)",
  taskUnknown: "too few sessions of this model to know a typical task length (TASK-1)",
  stepsUnknown: "too few user messages of this model to know how many steps one takes (STEPS-1)",
};

const UNKNOWN_SHORT: Readonly<Record<AdviceUnknownReason, string>> = {
  modelUnknown: "model",
  contextUnknown: "context size",
  freshStartUnknown: "fresh start",
  taskUnknown: "task length",
  stepsUnknown: "steps per message",
};

const CASE_UNKNOWN: Readonly<Record<NonNullable<AdviceCase["unknownReason"]>, string>> = {
  postCompactionUnknown: "too few compactions to know the context after one (POSTCOMPACT-1)",
  summaryUnknown: "too few compactions with a logged summary size (SUMMARY-1)",
};

export const TOKEN_LOAD_NOTE = "Compacting or starting fresh can discard details that still matter.";

const percent = (share: number | null) => (share === null ? "unknown" : `${Math.round(share * 100)}%`);

/** Weighted units, short, with a minus sign for negative values. */
function units(value: number | null): string {
  if (value === null) return "unknown";
  return value < 0 ? `−${f.compactTokens(-value)}` : f.compactTokens(value);
}

const subagents = (n: number) => `${n} ${f.plural(n, "subagent")}`;

/** The badges for a session's ADVICE-1 verdict: one, or two when both cases recommend a change. */
export function adviceBadges(a: SessionAdvice): HTMLElement[] {
  const badge = (text: string, tone: string, title: string) => h("span", { class: `badge ${tone}`.trim(), title: `ADVICE-1 · ${title}` }, text);
  switch (a.verdict) {
    case "wait":
      return [badge(`Wait · ${subagents(a.activeSubagentCount)} running`, "good", adviceSentence(a))];
    case "unknown":
      return [badge(`Unknown · ${UNKNOWN_SHORT[a.unknownReason ?? "contextUnknown"]}`, "", adviceSentence(a))];
    case "lean":
      return [badge("Keep going · lean context", "good", adviceSentence(a))];
    case "compare": {
      const out: HTMLElement[] = [];
      const title = `${adviceSentence(a)} ${TOKEN_LOAD_NOTE}`;
      const n = (c: AdviceCase) => c.breakEvenMessages ?? 0;
      if (a.newTask?.advice === "startFresh") {
        out.push(badge(n(a.newTask) <= 1 ? "New task? Start fresh" : `New task of ${n(a.newTask)}+ messages? Start fresh`, "warn", title));
      }
      if (a.sameTask?.advice === "compact") {
        out.push(badge(n(a.sameTask) <= 1 ? "Same task? Compact" : `Task goes on ${n(a.sameTask)}+ messages? Compact`, "warn", title));
      }
      return out.length > 0 ? out : [badge("Keep going", "good", adviceSentence(a))];
    }
  }
}

/** The first badge, for places that show one (the detail drawer header). */
export function adviceBadge(a: SessionAdvice): HTMLElement | null {
  return adviceBadges(a)[0] ?? null;
}

/** "pays back after ~2 messages", "pays back at once" or "never pays back". */
function paysBack(c: AdviceCase): string {
  const steps = c.option?.breakEvenSteps ?? null;
  if (steps === null) return "never pays back";
  if (steps === 0) return "pays back at once";
  const n = c.breakEvenMessages ?? 0;
  return `pays back after ~${n} ${f.plural(n, "message")}`;
}

/** One line under the badges: what the comparison saves, or why there is none. */
function adviceSummary(a: SessionAdvice): string {
  switch (a.verdict) {
    case "wait":
      return "results return to this session";
    case "unknown":
      return UNKNOWN[a.unknownReason ?? "contextUnknown"];
    case "lean":
      return `context under ${f.compactTokens(a.leanContextTokens)}`;
    case "compare": {
      const parts: string[] = [];
      if (a.newTask !== null) parts.push(`fresh ${paysBack(a.newTask)}`);
      if (a.sameTask?.advice === "compact") parts.push(`compact ${paysBack(a.sameTask)}`);
      parts.push(`typical task ~${a.taskMessages} ${f.plural(a.taskMessages ?? 0, "message")}`);
      return parts.join(" · ");
    }
  }
}

/** Short workflow line: active-window steps by STEP-1 class, subagents and the split break-even. */
function workflowSubtitle(w: WorkflowProfile): string {
  const parts = [
    w.turns === 0
      ? "just compacted"
      : `${w.turns} ${f.plural(w.turns, "turn")} (${w.editTurns} edit, ${w.exploreTurns} explore, ${w.otherTurns} other)`,
  ];
  if (w.subagentCount > 0) {
    parts.push(subagents(w.subagentCount) + (w.activeSubagentCount > 0 ? ` (${w.activeSubagentCount} active)` : ""));
  }
  if (w.splitBreakEvenSteps !== null) parts.push(`split subtasks ≥ ${w.splitBreakEvenSteps} ${f.plural(w.splitBreakEvenSteps, "step")}`);
  return parts.join(" · ");
}

/** The badges and summary lines for a session, with a compact "Why?" trigger that opens the detail drawer (ADR 0017). */
export function adviceTag(a: SessionAdvice | null | undefined, onWhy?: (advice: SessionAdvice) => void): HTMLElement {
  if (a === null || a === undefined) return h("span", { class: "muted" }, "");
  const whyBtn =
    onWhy === undefined
      ? null
      : (() => {
          const btn = h("button", { type: "button", class: "btn btn-sm col-toggle advice-why-btn" }, "Why?");
          btn.addEventListener("click", () => onWhy(a));
          return btn;
        })();
  return h(
    "div",
    { class: "advice-wrap" },
    h("div", { class: "d-flex flex-wrap align-items-center gap-2" }, ...adviceBadges(a), whyBtn),
    h("div", { class: "muted small mt-1 advice-summary" }, adviceSummary(a)),
    h("div", { class: "muted small advice-summary" }, workflowSubtitle(a.workflow)),
  );
}

function caseSentence(label: string, c: AdviceCase, alternative: string, a: SessionAdvice): string {
  if (c.unknownReason !== null) return `${label}: keep going; ${alternative} cannot be compared: ${CASE_UNKNOWN[c.unknownReason]}.`;
  const verdict = c.advice === "keepGoing" ? "keep going" : alternative;
  const name = `${alternative[0]?.toUpperCase()}${alternative.slice(1)}`;
  const steps = c.option?.breakEvenSteps ?? null;
  const typical = `a typical task is ${a.taskSteps} steps (~${a.taskMessages} messages)`;
  if (steps === null) return `${label}: keep going. ${name} never pays back: it starts above keeping going and saves nothing per step.`;
  if (steps === 0) return `${label}: ${verdict}. ${name} is cheaper from the first step.`;
  return `${label}: ${verdict}. ${name} pays back after ${steps} ${f.plural(steps, "step")} ` +
    `(~${c.breakEvenMessages} ${f.plural(c.breakEvenMessages ?? 0, "message")}); ${typical}.`;
}

/** What to do and why, in one or more sentences (ADR 0017, R-51, R-60, R-62). */
export function adviceSentence(a: SessionAdvice): string {
  switch (a.verdict) {
    case "wait":
      return `Wait in this session: ${subagents(a.activeSubagentCount)} ${a.activeSubagentCount === 1 ? "is" : "are"} running and will report back here.`;
    case "unknown":
      return `No advice: ${UNKNOWN[a.unknownReason ?? "contextUnknown"]}.`;
    case "lean":
      return `Keep going: the context (${f.tokens(a.contextTokens)} tokens) is under ${f.tokens(a.leanContextTokens)}, so it is worth more than the tokens a change would save.`;
    case "compare":
      return [
        a.newTask === null ? "" : caseSentence("For a new task", a.newTask, "start a new session", a),
        a.sameTask === null ? "" : caseSentence("To continue this task", a.sameTask, "compact", a),
      ].filter((s) => s !== "").join(" ");
  }
}

/** One sentence on the WORKFLOW-1 profile. */
export function workflowSentence(w: WorkflowProfile): string {
  const steps = `${w.turns} ${f.plural(w.turns, "turn")} in the active window: ${w.editTurns} edit, ${w.exploreTurns} explore, ${w.otherTurns} other (STEP-1).`;
  const heavy = w.explorationHeavy ? " The context grew mainly from read and search steps: delegate independent multi-step searches to a subagent." : "";
  const split =
    w.splitBreakEvenSteps === null ? "" : ` Independent subtasks of ${w.splitBreakEvenSteps}+ steps use fewer context tokens in a subagent.`;
  const subs = w.subagentCount > 0 ? ` Subagents used ${f.compactTokens(w.subagentTokens)} tokens.` : "";
  return `${steps}${heavy}${split}${subs}`;
}

function optionRow(name: string, o: OptionLoad, c: AdviceCase | null): HTMLElement {
  const chosen = c !== null && c.advice === o.option;
  return h(
    "tr",
    chosen ? { class: "table-active fw-semibold" } : {},
    h("td", {}, name),
    h("td", { class: "num" }, units(o.oneTime)),
    h("td", { class: "num" }, units(o.perStep)),
    h("td", { class: "num" }, units(o.total)),
    h("td", { class: "num" }, c === null ? "" : `${units(c.saving)} (${percent(c.savingShare)})`),
    h("td", { class: "num" }, c === null ? "" : o.breakEvenSteps === null ? "never" : `${o.breakEvenSteps} (~${c.breakEvenMessages} msg)`),
  );
}

/** The figures behind the advice, rendered inside the detail drawer (R-17, R-63). */
export function adviceDetailsNodes(a: SessionAdvice, onNavigate?: () => void): HTMLElement[] {
  const { freshStart, task, steps, postCompaction, summary } = a.figures;
  const evidenceLink = sessionLink(a.sessionId, "Session evidence");
  if (onNavigate !== undefined) evidenceLink.addEventListener("click", onNavigate);

  const nodes: HTMLElement[] = [h("p", { class: "small" }, adviceSentence(a))];
  nodes.push(
    h(
      "p",
      { class: "muted small" },
      `Context now ${f.tokens(a.contextTokens)} tokens, cache ${a.warm ? "warm" : "cold"}. ` +
        `A new session starts at ${f.tokens(freshStart?.medianContextTokens ?? null)} (FRESH-1, ${freshStart?.sessions ?? 0} sessions). ` +
        `A task takes ${task?.medianSteps ?? "unknown"} steps (TASK-1, ${task?.sessions ?? 0} sessions); ` +
        `a message takes ${steps?.medianSteps ?? "unknown"} steps (STEPS-1, ${steps?.userTurns ?? 0} messages). ` +
        `After compacting: ${f.tokens(postCompaction?.medianContextTokens ?? null)} (POSTCOMPACT-1, ${postCompaction?.compactions ?? 0} compactions), ` +
        `summary ${f.tokens(summary?.medianTokens ?? null)} (SUMMARY-1, an estimate: the summarization request is not logged).`,
    ),
  );
  if (a.verdict === "compare" && a.keep !== null) {
    const rows = [optionRow("Keep going", a.keep, null)];
    if (a.newTask?.option != null) rows.push(optionRow("New session (new task)", a.newTask.option, a.newTask));
    if (a.sameTask?.option != null) rows.push(optionRow("Compact (same task)", a.sameTask.option, a.sameTask));
    nodes.push(
      h(
        "div",
        { class: "table-responsive table-card mb-3", tabindex: "0" },
        h(
          "table",
          { class: "table table-sm align-middle text-nowrap small mb-0" },
          h("thead", {}, h("tr", {}, ["Option", "Initial units", "Units per step", `Units over a typical task (${a.taskSteps} steps)`, "Saving", "Break-even, steps"].map((t) => h("th", { scope: "col" }, t)))),
          h("tbody", {}, rows),
        ),
      ),
    );
  }
  nodes.push(
    h("p", { class: "muted small" }, workflowSentence(a.workflow)),
    h(
      "p",
      { class: "muted small" },
      `ADVICE-1 parameters: lean below ${f.tokens(a.leanContextTokens)} tokens; a change is recommended when it pays back within a typical task (TASK-1); ` +
        `weights cache read ×${a.weights.cacheRead}, cache write ×${a.weights.cacheWrite}, output ×${a.weights.output}. `,
      evidenceLink,
    ),
    h("p", { class: "muted small mb-0" }, TOKEN_LOAD_NOTE),
  );
  return nodes;
}
