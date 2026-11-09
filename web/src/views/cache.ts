// View 3, "Cache": observed and declared lifetimes, gap bands and miss causes (ADR 0009, R-41 to R-43).
// Written for a reader who does not know the rules: plain sentences first, rule IDs in tooltips.

import type { GapBand, LifetimeGroup, MissCauseKind } from "../../../src/core/analysis/cache.js";
import type { cache, CauseTotal } from "../../../src/core/api/index.js";
import { h, table } from "../dom.js";
import * as f from "../format.js";

type Cache = ReturnType<typeof cache>;

const CAUSE_ORDER: readonly MissCauseKind[] = ["idleBeyondLifetime", "prematureLoss", "compaction", "modelSwitch"];

export function renderCache(data: Cache): HTMLElement {
  return h(
    "div",
    {},
    h("h2", {}, "How long does the cache last?"),
    h(
      "p",
      { class: "muted" },
      "After a pause, the agent either still finds its cache (cheap) or must re-read the whole conversation at full price. These numbers come from the pauses in your own logs, measured apart for each lifetime the harness promised.",
    ),
    data.lifetimes.length === 0 ? h("p", { class: "muted" }, "No pauses observed yet.") : h("div", { class: "cards" }, data.lifetimes.map(lifetimeCard)),
    h("h2", {}, "Why was the cache lost?"),
    causes(data.causes),
  );
}

function lifetimeCard(g: LifetimeGroup): HTMLElement {
  const pauses = g.survived + g.gone;
  return h(
    "div",
    { class: "card" },
    h("div", { class: "label" }, `${f.harness(g.harness)} · ${f.model(g.model, g.modelSource)}`),
    h(
      "div",
      { class: "promise", title: "DECL-1 · the lifetime the harness's logs declared for the cache before each pause" },
      g.declaredLifetimeSeconds === null ? "No lifetime promised" : ["Promised ", h("strong", {}, f.duration(g.declaredLifetimeSeconds))],
    ),
    h(
      "div",
      { class: "value", title: "LIFE-1 · median of the observed lifetime; logs never record the moment of eviction" },
      g.sufficient ? `lasts about ${f.duration(g.medianSeconds)}` : h("span", { class: "muted", title: "Not enough pauses yet to say how long it lasts" }, "insufficient data"),
    ),
    h(
      "div",
      {},
      g.gone === 0
        ? h("span", { class: "badge good" }, `never lost after ${f.tokens(pauses)} pauses`)
        : h("span", { class: "badge" }, `kept after ${percent(g.survived, pauses)} of ${f.tokens(pauses)} pauses`),
    ),
    h(
      "div",
      { class: "muted small facts" },
      h("div", {}, `Longest pause it survived: ${f.duration(g.longestSurvivedSeconds)}`),
      g.shortestGoneSeconds === null ? null : h("div", {}, `Shortest pause it was lost after: ${f.duration(g.shortestGoneSeconds)}`),
    ),
    h("div", { class: "label bands-title" }, "After a pause of…"),
    h("div", { class: "bands" }, g.bands.filter((b) => b.survived + b.gone > 0).flatMap(bandRow)),
  );
}

/** One gap band as a kept/lost bar; a <progress> element because the CSP forbids inline widths. */
function bandRow(b: GapBand): HTMLElement[] {
  const total = b.survived + b.gone;
  return [
    h("span", {}, bandLabel(b)),
    h("progress", { class: "kept", value: String(b.survived), max: String(total), title: `${f.tokens(b.survived)} kept, ${f.tokens(b.gone)} lost` }),
    h("span", { class: "muted small" }, b.gone === 0 ? `${f.tokens(b.survived)} kept` : `${f.tokens(b.survived)} kept · ${f.tokens(b.gone)} lost`),
  ];
}

function bandLabel(b: GapBand): string {
  if (b.fromSeconds === 0 && b.toSeconds !== null) return `under ${f.duration(b.toSeconds)}`;
  if (b.toSeconds === null) return `over ${f.duration(b.fromSeconds)}`;
  return `${f.duration(b.fromSeconds)} – ${f.duration(b.toSeconds)}`;
}

function causes(rows: readonly CauseTotal[]): HTMLElement {
  if (rows.length === 0) return h("p", { class: "muted" }, "No cache losses observed.");
  const reRead = (c: { reReadTokens: number; reReadUnknown: number }) =>
    h("span", { title: `${f.tokens(c.reReadTokens)} tokens` }, f.compactTokens(c.reReadTokens) + (c.reReadUnknown > 0 ? ` (+${c.reReadUnknown} unknown)` : ""));
  const summary = CAUSE_ORDER.map((cause) => {
    const of = rows.filter((r) => r.cause === cause);
    return { cause, losses: of.reduce((a, r) => a + r.losses, 0), reReadTokens: of.reduce((a, r) => a + r.reReadTokens, 0), reReadUnknown: of.reduce((a, r) => a + r.reReadUnknown, 0) };
  }).filter((s) => s.losses > 0);

  return h(
    "div",
    {},
    h(
      "div",
      { class: "cards" },
      summary.map((s) => {
        const [label, explanation] = f.CAUSE[s.cause];
        const tone = s.cause === "prematureLoss" ? "bad" : "";
        return h(
          "div",
          { class: tone === "bad" ? "card alert" : "card", title: "CAUSE-1 · exactly one cause per loss, in order: model switch, compaction, idle beyond lifetime, premature loss" },
          h("div", { class: "label" }, label),
          h("div", { class: "value" }, `${f.tokens(s.losses)} times`),
          h("div", {}, reRead(s), " tokens paid again at full price"),
          h("div", { class: "muted small" }, explanation),
        );
      }),
    ),
    h("h2", {}, "By harness and model"),
    table(
      [
        { title: "Where", cell: (c: CauseTotal) => `${f.harness(c.harness)} · ${f.model(c.model, c.modelSource)}` },
        {
          title: "Why",
          cell: (c) => {
            const [label, explanation] = f.CAUSE[c.cause];
            const tone = c.cause === "prematureLoss" ? "bad" : "";
            return h("span", { class: `badge ${tone}`, title: explanation }, label);
          },
        },
        { title: "Times", numeric: true, cell: (c) => c.losses },
        { title: "Tokens paid again", numeric: true, cell: reRead },
      ],
      rows,
    ),
  );
}

function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}
