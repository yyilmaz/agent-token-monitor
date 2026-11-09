// View 1, "Now": open sessions, today and this month (R-33, ADR 0013). Diagnostics live here too (R-23).

import type { OpenSession, TreeRow } from "../../../src/core/analysis/live.js";
import type { UsageFigures } from "../../../src/core/analysis/usage.js";
import type { diagnostics, overview } from "../../../src/core/api/index.js";
import type { Diagnostic } from "../../../src/core/model/index.js";
import { adviceTag } from "../advice.js";
import { card, h, sessionLink, table } from "../dom.js";
import * as f from "../format.js";

type Overview = ReturnType<typeof overview>;

const STATUS: Readonly<Record<OpenSession["cacheStatus"], [string, string]>> = {
  warm: ["warm", "good"],
  probablyCold: ["probably cold", "warn"],
  missedOnLastCall: ["missed on last call", "bad"],
};

export function renderNow(data: Overview): HTMLElement {
  const decimals = data.configuration.pricing.displayDecimals;
  const usageCard = (label: string, usage: UsageFigures | null) =>
    card(
      label,
      usage === null ? "no calls" : f.compactTokens(usage.inputUncached.total + usage.cacheRead.total + usage.cacheWrite.total + usage.output.total) + " tokens",
      usage === null ? null : `List-price equivalent: ${f.cost(usage.cost, decimals)} (not your bill)`,
      usage === null ? null : `${usage.calls} calls · uncached ${f.compactTokens(usage.inputUncached.total)} · cache read ${f.compactTokens(usage.cacheRead.total)} · cache write ${f.compactTokens(usage.cacheWrite.total)} · output ${f.compactTokens(usage.output.total)}`,
    );

  const adviceById = new Map(data.sessionAdvice.map((a) => [a.sessionId, a]));
  const diagCount = data.diagnostics.errors + data.diagnostics.warnings;

  return h(
    "div",
    {},
    h(
      "div",
      { class: "cards" },
      usageCard(`Today (${data.today.period})`, data.today.usage?.total ?? null),
      usageCard(`This month (${data.thisMonth.period})`, data.thisMonth.usage?.total ?? null),
      diagCount > 0
        ? h(
            "div",
            { class: "card" },
            h("div", { class: "label" }, "Diagnostics"),
            h("div", { class: "value" }, h("a", { href: "#diagnostics" }, `${diagCount} log diagnostics`)),
          )
        : null,
    ),
    h("h2", {}, "Open sessions"),
    table(
      [
        { title: "Session", cell: (r: TreeRow) => sessionCell(r) },
        { title: "Harness", cell: (r) => f.harness(r.harness) },
        {
          title: "Model",
          cell: (r) => {
            if (r.open !== null) return f.model(r.open.model, r.open.modelSource);
            const adv = adviceById.get(r.sessionId);
            return adv !== undefined && adv.model !== null ? f.model(adv.model, adv.modelSource) : "";
          },
        },
        {
          title: "Context",
          numeric: true,
          cell: (r) => {
            const ctx = r.open !== null ? r.open.contextTokens : (adviceById.get(r.sessionId)?.contextTokens ?? null);
            return ctx === null ? "" : h("span", { title: `${f.tokens(ctx)} tokens` }, f.compactTokens(ctx));
          },
        },
        {
          title: "Step load (avg)",
          help: "Recent 5-step weighted average load per step (and active window average since last compaction).",
          numeric: true,
          cell: (r) => {
            const load = data.sessionLoads[r.sessionId];
            if (load === undefined || load.recentAvgWeightedTokens === null) return "—";
            return h(
              "span",
              {
                title: `Recent avg: ${f.tokens(load.recentAvgWeightedTokens)} / step · Active window avg: ${f.tokens(load.activeWindowAvgWeightedTokens)} / step (${load.activeTurns} steps)`,
              },
              `${f.compactTokens(load.recentAvgWeightedTokens)}/step`,
            );
          },
        },
        {
          title: "Total weighted",
          help: "Total weighted load of the session (including child subagents for top-level sessions) so you can compare total cost across tasks.",
          numeric: true,
          cell: (r) => {
            const load = data.sessionLoads[r.sessionId];
            if (load === undefined) return "—";
            return h(
              "span",
              {
                title:
                  load.subagentCount > 0
                    ? `Main: ${f.tokens(load.sessionWeightedTokens)} + Subagents (${load.subagentCount}): ${f.tokens(load.subagentWeightedTokens)}`
                    : `${f.tokens(load.sessionWeightedTokens)} weighted units across ${load.totalTurns} steps`,
              },
              f.compactTokens(load.combinedWeightedTokens),
            );
          },
        },
        { title: "Since last call", numeric: true, cell: (r) => (r.open === null ? "" : f.duration(r.open.secondsSinceLastCall)) },
        {
          title: "Cache",
          cell: (r) => {
            if (r.open === null) return h("span", { class: "badge", title: "TREE-1 · no call of its own within the open window; a session under it is active" }, "waiting");
            const s = r.open;
            const [text, tone] = STATUS[s.cacheStatus];
            return h("span", { class: `badge ${tone}`, title: `LIVE-1 · reference lifetime ${f.duration(s.referenceLifetimeSeconds)} (${s.referenceSource})` }, text);
          },
        },
        // ADR 0017: keep going, compact now or start fresh; the reason in money on hover.
        { title: "Advice", cell: (r) => adviceTag(adviceById.get(r.sessionId), decimals) },
      ],
      data.sessionTree,
      `No session had a call in the last ${f.duration(data.configuration.liveView.openWithinSeconds)}.`,
      undefined,
      "open-sessions",
    ),
  );
}

/** The title, else the project folder or short session ID, indented under the session that started it (TREE-1, ADR 0016). */
function sessionCell(r: TreeRow): HTMLElement {
  const isSubagent = r.relation === "subagent";
  const hasName = r.title !== null || r.project !== null;
  const name = r.title ?? (r.project !== null ? f.project(r.project) : f.shortSessionId(r.sessionId, isSubagent));
  return h(
    "span",
    { class: "tree", "data-depth": String(Math.min(r.depth, 6)) },
    r.depth > 0 ? h("span", { class: "muted" }, "↳ ") : null,
    sessionLink(r.sessionId, name),
    r.relation === "root" || (!hasName && isSubagent)
      ? null
      : h("span", { class: "muted small" }, isSubagent ? " · subagent" : " · side session"),
    r.title === null || r.project === null ? null : h("div", { class: "muted small" }, f.project(r.project)),
  );
}

export function renderDiagnostics(data: ReturnType<typeof diagnostics>): HTMLElement {
  return table(
    [
      { title: "Harness", cell: (d: Diagnostic) => f.harness(d.harness) },
      { title: "Severity", cell: (d) => d.severity },
      { title: "Code", cell: (d) => d.code },
      { title: "Message", cell: (d) => d.message },
      { title: "Where", cell: (d) => d.sources.map((s) => `${s.file}:${s.line}`).join(", ") },
    ],
    data.diagnostics,
    "Every log line was read.",
  );
}

