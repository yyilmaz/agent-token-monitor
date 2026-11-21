// View 3, "Cache": observed and declared lifetimes, gap bands and miss causes (ADR 0009, R-41 to R-43).
// Written for a reader who does not know the rules: plain sentences first, rule IDs in tooltips.

import type { GapBand, LifetimeGroup, MissCauseKind } from "../../../src/core/analysis/cache.js";
import type { cache, CauseTotal } from "../../../src/core/api/index.js";
import type { HarnessId } from "../../../src/core/model/index.js";
import { harnessLabel, modelLabel } from "../badges.js";
import { card, h, segmented } from "../dom.js";
import * as f from "../format.js";

type Cache = ReturnType<typeof cache>;

export interface CacheState {
  readonly range: "all" | number;
  readonly harness: string;
}

const CAUSE_ORDER: readonly MissCauseKind[] = ["idleBeyondLifetime", "prematureLoss", "compaction", "modelSwitch"];
const HARNESS_ORDER: readonly HarnessId[] = ["claudeCode", "antigravity", "codex", "opencode"];

export function renderCache(data: Cache, state: CacheState, onChange: (next: CacheState) => void): HTMLElement {
  const ranges = data.configuration.ui.usageRangesDays;
  const rangeOptions: [string, string][] = [
    ["all", "All time"],
    ["1", "Today"],
    ...ranges.flatMap((n): [string, string][] => (n === 1 ? [] : [[String(n), `Last ${n} days`]])),
  ];
  const activeRange = state.range === "all" ? "all" : String(state.range);
  const rangeButtons = segmented(rangeOptions, activeRange, (v) =>
    onChange({ ...state, range: v === "all" ? "all" : Number(v) }),
  );

  const presentHarnesses = HARNESS_ORDER.filter(
    (id) => data.lifetimes.some((g) => g.harness === id) || data.causes.some((c) => c.harness === id),
  );
  const activeHarness = state.harness !== "" && presentHarnesses.includes(state.harness as HarnessId) ? state.harness : "";
  const harnessButtons =
    presentHarnesses.length > 0
      ? segmented(
          [["", "All harnesses"], ...presentHarnesses.map((id): [string, string] => [id, f.harness(id)])],
          activeHarness,
          (v) => onChange({ ...state, harness: v }),
        )
      : null;

  const lifetimes = activeHarness === "" ? data.lifetimes : data.lifetimes.filter((g) => g.harness === activeHarness);
  const causesRows = activeHarness === "" ? data.causes : data.causes.filter((c) => c.harness === activeHarness);

  return h(
    "div",
    {},
    h("div", { class: "d-flex flex-wrap align-items-center gap-3 mb-4" }, rangeButtons, harnessButtons),
    summaryStrip(lifetimes, causesRows),
    h("h2", {}, "How long does the cache last?"),
    h(
      "p",
      { class: "muted" },
      "After a pause, the agent either still finds its cache or must re-read the conversation without it. These numbers come from the pauses in your own logs, grouped by harness and model.",
    ),
    lifetimes.length === 0
      ? h("p", { class: "muted" }, "No pauses observed in this range.")
      : groupedByHarness(lifetimes, causesRows),
    lifetimes.some((g) => f.model(g.model, g.modelSource, g.harness) === f.UNKNOWN_GEMINI_MODEL_LABEL)
      ? h("p", { class: "muted small mt-2" }, f.UNKNOWN_GEMINI_MODEL_NOTE)
      : null,
    h("h2", {}, "Why was the cache lost?"),
    causes(causesRows),
  );
}

function summaryStrip(lifetimes: readonly LifetimeGroup[], causesRows: readonly CauseTotal[]): HTMLElement {
  const survived = lifetimes.reduce((a, g) => a + g.survived, 0);
  const gone = lifetimes.reduce((a, g) => a + g.gone, 0);
  const pauses = survived + gone;
  const losses = causesRows.reduce((a, c) => a + c.losses, 0);
  const reReadTokens = causesRows.reduce((a, c) => a + c.reReadTokens, 0);
  const reReadUnknown = causesRows.reduce((a, c) => a + c.reReadUnknown, 0);

  return h(
    "div",
    { class: "cards d-grid gap-4 mb-4" },
    card(
      "Pauses observed",
      pauses === 0 ? "0" : `${f.tokens(pauses)}`,
      pauses === 0 ? "No idle gaps in this selection" : `${percent(survived, pauses)} kept · ${f.tokens(gone)} lost`,
    ),
    card(
      "Cache losses",
      `${f.tokens(losses)} times`,
      losses === 0 ? "No cache losses recorded" : "Full misses or small-share partial hits",
    ),
    card(
      "Re-read without cache",
      f.compactTokens(reReadTokens) + (reReadUnknown > 0 ? ` (+${reReadUnknown})` : ""),
      `${f.tokens(reReadTokens)} tokens re-read across losses`,
    ),
  );
}

function groupedByHarness(lifetimes: readonly LifetimeGroup[], causesRows: readonly CauseTotal[]): HTMLElement {
  const harnesses = HARNESS_ORDER.filter((id) => lifetimes.some((g) => g.harness === id));
  return h(
    "div",
    { class: "d-grid gap-5" },
    harnesses.map((harness) => {
      const items = lifetimes.filter((g) => g.harness === harness);
      const harnessCauses = causesRows.filter((c) => c.harness === harness);
      const survived = items.reduce((a, g) => a + g.survived, 0);
      const gone = items.reduce((a, g) => a + g.gone, 0);
      const pauses = survived + gone;
      const reRead = harnessCauses.reduce((a, c) => a + c.reReadTokens, 0);

      // Group tiers by (model, modelSource) so one model renders as one compact card.
      const byModel = new Map<string, LifetimeGroup[]>();
      for (const g of items) {
        const key = `${g.model}\u0000${g.modelSource}`;
        const list = byModel.get(key);
        if (list === undefined) byModel.set(key, [g]);
        else list.push(g);
      }

      return h(
        "section",
        { class: "cache-harness-group" },
        h(
          "div",
          { class: "cache-harness-header d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3" },
          h("div", { class: "d-flex align-items-center gap-2" }, harnessLabel(harness)),
          h(
            "div",
            { class: "muted small" },
            `${f.tokens(pauses)} ${f.plural(pauses, "pause")} · ${percent(survived, pauses)} kept` +
              (reRead > 0 ? ` · ${f.compactTokens(reRead)} re-read` : ""),
          ),
        ),
        h("div", { class: "cards d-grid gap-4" }, [...byModel.values()].map(modelCard)),
      );
    }),
  );
}

function modelCard(groups: readonly LifetimeGroup[]): HTMLElement {
  const first = groups[0] as LifetimeGroup;
  const modelLabelText = f.model(first.model, first.modelSource, first.harness);
  return h(
    "div",
    { class: "card p-4" },
    h(
      "div",
      { class: "label mb-2", ...(modelLabelText === f.UNKNOWN_GEMINI_MODEL_LABEL ? { title: f.UNKNOWN_GEMINI_MODEL_NOTE } : {}) },
      modelLabel(first.model, first.modelSource, first.harness),
    ),
    h("div", { class: "d-grid gap-3" }, groups.map((g, index) => tierBlock(g, index > 0))),
  );
}

function tierBlock(g: LifetimeGroup, divider: boolean): HTMLElement {
  const pauses = g.survived + g.gone;
  return h(
    "div",
    { class: divider ? "cache-tier pt-3" : "cache-tier" },
    h(
      "div",
      { class: "d-flex flex-wrap align-items-baseline justify-content-between gap-2 mb-1" },
      h(
        "span",
        { class: "small", title: "DECL-1 · the lifetime the harness's logs declared for the cache before each pause" },
        g.declaredLifetimeSeconds === null ? "No lifetime promised" : ["Promised ", h("strong", {}, f.duration(g.declaredLifetimeSeconds))],
      ),
      g.gone === 0
        ? h("span", { class: "badge good" }, `never lost · ${f.tokens(pauses)}`)
        : h("span", { class: "badge" }, `${percent(g.survived, pauses)} kept · ${f.tokens(pauses)}`),
    ),
    h(
      "div",
      { class: "cache-tier-value mb-1", title: "LIFE-1 · median of the observed lifetime; logs never record the moment of eviction" },
      g.sufficient
        ? `lasts about ${f.duration(g.medianSeconds)}`
        : h("span", { class: "muted", title: "Not enough pauses yet to say how long it lasts" }, "insufficient data"),
    ),
    h(
      "div",
      { class: "muted small mb-2" },
      `Longest kept: ${f.duration(g.longestSurvivedSeconds)}` +
        (g.shortestGoneSeconds === null ? "" : ` · Shortest lost: ${f.duration(g.shortestGoneSeconds)}`),
    ),
    h("div", { class: "bands d-grid align-items-center row-gap-1 column-gap-3 small" }, g.bands.filter((b) => b.survived + b.gone > 0).flatMap(bandRow)),
  );
}

/** One gap band as a kept/lost bar; a <progress> element because the CSP forbids inline widths. */
function bandRow(b: GapBand): HTMLElement[] {
  const total = b.survived + b.gone;
  return [
    h("span", {}, bandLabel(b)),
    h("progress", { class: "progress kept", value: String(b.survived), max: String(total), title: `${f.tokens(b.survived)} kept, ${f.tokens(b.gone)} lost` }),
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
    { class: "cards d-grid gap-4" },
    summary.map((s) => {
      const [label, explanation] = f.CAUSE[s.cause];
      const tone = s.cause === "prematureLoss" ? "bad" : "";
      return h(
        "div",
        { class: tone === "bad" ? "card p-4 loss-card" : "card p-4", title: "CAUSE-1 · exactly one cause per loss, in order: model switch, compaction, idle beyond lifetime, premature loss" },
        h("div", { class: "label" }, label),
        h("div", { class: "value" }, `${f.tokens(s.losses)} times`),
        h("div", {}, reRead(s), " tokens re-read without a cache hit"),
        h("div", { class: "muted small" }, explanation),
      );
    }),
  );
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}
