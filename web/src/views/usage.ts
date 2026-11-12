// View 2, "Usage": daily token and weighted load charts with range totals by harness, model or project (USE-1, R-33).

import type { TokenSum, UsageFigures, UsagePeriod } from "../../../src/core/analysis/usage.js";
import type { usage } from "../../../src/core/api/index.js";
import { barChart } from "../chart.js";
import { h } from "../dom.js";
import * as f from "../format.js";

type Usage = ReturnType<typeof usage>;
export type Where = "harness" | "project" | "model";

type ChartKind = "total" | "input" | "output" | "weighted";
type ChartMode = "harness" | "total";

export interface UsageState {
  /** Today or an index into `ui.usageRangesDays`. */
  readonly range: "today" | number;
  readonly where: Where;
  readonly harness: string;
  readonly project: string;
  readonly chartModes: Readonly<Partial<Record<ChartKind, ChartMode>>>;
}

/** Each harness keeps its color wherever it appears, whatever is filtered (dataviz: color follows the entity). */
const HARNESS_COLOR: Readonly<Record<string, string>> = { claudeCode: "--series-1", antigravity: "--series-2", codex: "--series-3", opencode: "--series-4" };
const HARNESS_ORDER = ["claudeCode", "antigravity", "codex", "opencode"];

const all = (t: UsageFigures) => t.inputUncached.total + t.cacheRead.total + t.cacheWrite.total + t.output.total;

export function renderUsage(days: Usage, state: UsageState, onChange: (next: UsageState) => void): HTMLElement {
  const ranges = days.configuration.ui.usageRangesDays;
  const range = state.range === "today" ? "today" : Math.min(state.range, ranges.length - 1);
  const length = range === "today" ? 1 : ranges[range] as number;
  const today = dayIn(days.asOf, days.timeZone);
  const current = lastDays(today, length, 0);
  const before = lastDays(today, length, length);
  const byDay = new Map(days.periods.map((p) => [p.period, filterPeriod(p, state)]));
  const periods = current.map((d) => byDay.get(d));
  const inRange = periods.filter((p): p is UsagePeriod => p !== undefined);
  const previous = before.map((d) => byDay.get(d)).filter((p): p is UsagePeriod => p !== undefined);

  const xs = current.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);
  const rangeButtons = segmented(
    [["today", "Today"], ...ranges.flatMap((n, i): [string, string][] => n === 1 ? [] : [[String(i), `Last ${n} days`]])],
    length === 1 ? "today" : String(range),
    (v) => onChange({ ...state, range: v === "today" ? v : Number(v) }),
  );
  const filters = usageFilters(days.periods, state, onChange);
  const chart = (kind: ChartKind, title: string, unit: string, pick: ChartValue) =>
    dailyChart(xs, periods, kind, title, unit, pick, state, onChange);
  return h(
    "div",
    {},
    h("div", { class: "d-flex flex-wrap align-items-center gap-3 mb-5" }, rangeButtons, filters, sources(days.sources)),
    h(
      "div",
      { class: "usage-top" },
      summary(inRange, previous, length),
      chart("total", "Tokens per day", "tokens", all),
    ),
    where(inRange, state, onChange),
    measureCharts(periods, chart, state.project !== ""),
  );
}

function usageFilters(allPeriods: readonly UsagePeriod[], state: UsageState, onChange: (next: UsageState) => void): HTMLElement | null {
  const harnesses = HARNESS_ORDER.filter((id) => allPeriods.some((p) => p.byHarness.some((s) => s.harness === id)));
  const projects = [...new Set(allPeriods.flatMap((p) => p.byProject.map((s) => f.repository(s.project))))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (harnesses.length === 0 && projects.length === 0) return null;

  const harnessSelect = selectControl(
    "Filter usage by harness",
    [["", "All harnesses"], ...harnesses.map((id): [string, string] => [id, f.harness(id)])],
    state.harness,
    (v) => onChange({ ...state, harness: v, project: "" }),
  );
  const projectSelect = selectControl(
    "Filter usage by project",
    [["", "All projects"], ...projects.map((p): [string, string] => [p, p])],
    state.project,
    (v) => onChange({ ...state, project: v, harness: "" }),
  );
  const clear =
    state.harness === "" && state.project === ""
      ? null
      : (() => {
          const btn = h("button", { type: "button", class: "btn btn-sm col-toggle reset" }, "Clear");
          btn.addEventListener("click", () => onChange({ ...state, harness: "", project: "" }));
          return btn;
        })();

  return h("div", { class: "d-flex flex-wrap align-items-center gap-2" }, harnessSelect, projectSelect, clear);
}

function selectControl(ariaLabel: string, options: readonly (readonly [string, string])[], value: string, onSelect: (value: string) => void): HTMLSelectElement {
  const select = h(
    "select",
    { class: "form-control form-control-sm w-auto", "aria-label": ariaLabel },
    options.map(([v, label]) => h("option", v === value ? { value: v, selected: "" } : { value: v }, label)),
  );
  select.addEventListener("change", () => onSelect(select.value));
  return select;
}

const ZERO_SUM: TokenSum = { total: 0, unknownCalls: 0 };
const ZERO_FIGURES: UsageFigures = { calls: 0, inputUncached: ZERO_SUM, cacheRead: ZERO_SUM, cacheWrite: ZERO_SUM, output: ZERO_SUM, reasoning: ZERO_SUM };

function sumTokenSums(items: readonly TokenSum[]): TokenSum {
  return items.reduce((acc, s) => ({ total: acc.total + s.total, unknownCalls: acc.unknownCalls + s.unknownCalls }), ZERO_SUM);
}

function sumFigures(items: readonly UsageFigures[]): UsageFigures {
  if (items.length === 0) return ZERO_FIGURES;
  return {
    calls: items.reduce((a, x) => a + x.calls, 0),
    inputUncached: sumTokenSums(items.map((x) => x.inputUncached)),
    cacheRead: sumTokenSums(items.map((x) => x.cacheRead)),
    cacheWrite: sumTokenSums(items.map((x) => x.cacheWrite)),
    output: sumTokenSums(items.map((x) => x.output)),
    reasoning: sumTokenSums(items.map((x) => x.reasoning)),
  };
}

function filterPeriod(p: UsagePeriod, state: UsageState): UsagePeriod {
  if (state.harness !== "") {
    const byHarness = p.byHarness.filter((s) => s.harness === state.harness);
    const total = sumFigures(byHarness.map((s) => s.figures));
    const weightedItems = byHarness.map((s) => s.weightedTokenUnits).filter((w): w is TokenSum => w !== undefined);
    const weightedTokenUnits = weightedItems.length === byHarness.length ? sumTokenSums(weightedItems) : { total: 0, unknownCalls: total.calls };
    return {
      ...p,
      total,
      weightedTokenUnits,
      byHarness,
      byModel: p.byModel.filter((s) => s.harness === state.harness),
    };
  }
  if (state.project !== "") {
    const byProject = p.byProject.filter((s) => f.repository(s.project) === state.project);
    const total = sumFigures(byProject.map((s) => s.figures));
    return {
      ...p,
      total,
      byProject,
    };
  }
  return p;
}

function segmented(options: readonly (readonly [string, string])[], value: string, change: (value: string) => void): HTMLElement {
  return h(
    "div",
    { class: "btn-group segmented", role: "group" },
    options.map(([v, label]) => {
      const active = v === value;
      const button = h("button", { type: "button", class: active ? "btn btn-sm active" : "btn btn-sm", "aria-pressed": String(active) }, label);
      button.addEventListener("click", () => change(v));
      return button;
    }),
  );
}

/** Which harnesses are counted, and which are on this computer but not read yet, so nothing is left out silently (R-23). */
function sources(list: Usage["sources"]): HTMLElement | null {
  const read = list.filter((s) => s.read && s.files > 0);
  const waiting = list.filter((s) => !s.read && s.files > 0);
  if (read.length === 0 && waiting.length === 0) return null;
  const names = (items: Usage["sources"]) =>
    items.flatMap((s, i) => [i > 0 ? " · " : "", h("span", { title: `${f.tokens(s.files)} log ${s.files === 1 ? "file" : "files"} found` }, f.harness(s.harness))]);
  return h(
    "div",
    { class: "sources d-flex flex-wrap row-gap-1 column-gap-5 small" },
    read.length === 0 ? null : h("span", {}, h("span", { class: "dot good me-1" }, "●"), " Counting ", h("strong", {}, names(read))),
    waiting.length === 0 ? null : h("span", { class: "muted", title: "Their logs are on this computer, but their adapters come in Phase 2 (R-21)" }, h("span", { class: "me-1" }, "○"), " Found, not counted yet: ", names(waiting)),
  );
}

/** Total tokens, how it compares with the same number of days before, and the cache's share of the input. */
function summary(periods: readonly UsagePeriod[], before: readonly UsagePeriod[], length: number): HTMLElement {
  const tokens = periods.reduce((a, p) => a + all(p.total), 0);
  const then = before.reduce((a, p) => a + all(p.total), 0);
  const read = periods.reduce((a, p) => a + p.total.cacheRead.total, 0);
  const input = periods.reduce((a, p) => a + p.total.inputUncached.total + p.total.cacheRead.total + p.total.cacheWrite.total, 0);
  const unknown = periods.reduce((a, p) => a + Math.max(p.total.inputUncached.unknownCalls, p.total.cacheRead.unknownCalls, p.total.cacheWrite.unknownCalls, p.total.output.unknownCalls), 0);
  const comparison = length === 1 ? "yesterday" : `the ${length} days before`;
  const change =
    then === 0
      ? h("span", { class: "muted" }, length === 1 ? "nothing yesterday" : `nothing in ${comparison}`)
      : tokens === then
        ? h("span", { class: "badge" }, `same as ${comparison}`)
        : h("span", { class: "badge" }, `${tokens > then ? "↑" : "↓"} ${((Math.abs(tokens - then) / then) * 100).toFixed(0)}% vs ${comparison}`);
  return h(
    "div",
    { class: "card p-5 hero" },
    h("div", { class: "label" }, length === 1 ? "Tokens used today" : `Tokens used, last ${length} days`),
    h("div", { class: "big", title: `${f.tokens(tokens)} tokens` }, f.compactTokens(tokens)),
    h("div", {}, change),
    input === 0
      ? null
      : h(
          "p",
          { class: "mt-5 mb-2", title: "Cache read ÷ all input (uncached + cache read + cache write)" },
          h("strong", {}, `${((read / input) * 100).toFixed(1)}%`),
          " of the input came from the cache.",
        ),
    unknown === 0 ? null : h("div", { class: "muted small" }, `Up to ${f.tokens(unknown)} ${f.plural(unknown, "call")} did not log every count and ${unknown === 1 ? "is" : "are"} left out.`),
  );
}

type ChartValue = (figures: UsageFigures, weighted?: TokenSum) => number | null;
type UsageChart = (kind: ChartKind, title: string, unit: string, pick: ChartValue) => HTMLElement;

/** A total or side-by-side harness bars. The legend toggles individual harnesses. */
function dailyChart(
  xs: readonly number[], periods: readonly (UsagePeriod | undefined)[],
  kind: ChartKind, title: string, unit: string, pick: ChartValue,
  state: UsageState, onChange: (next: UsageState) => void,
): HTMLElement {
  const mode = state.project !== "" ? "total" : (state.chartModes[kind] ?? "harness");
  const harnesses = HARNESS_ORDER.filter((id) => periods.some((p) => p?.byHarness.some((s) => s.harness === id)));
  const groups = mode === "total"
    ? [{ label: state.project !== "" ? state.project : state.harness !== "" ? f.harness(state.harness) : "All harnesses", colorVar: "--series-1", ys: periods.map((p) => p === undefined ? 0 : pick(p.total, p.weightedTokenUnits)) }]
    : harnesses.map((id) => ({
      label: f.harness(id),
      colorVar: HARNESS_COLOR[id] as string,
      ys: periods.map((p) => {
        const split = p?.byHarness.find((s) => s.harness === id);
        return split === undefined ? 0 : pick(split.figures, split.weightedTokenUnits);
      }),
    }));
  const toggle = state.project !== "" ? null : segmented(
    [
      ["harness", "Per harness"],
      ["total", "Total"],
    ],
    mode,
    (v) => onChange({ ...state, chartModes: { ...state.chartModes, [kind]: v as ChartMode } }),
  );
  return h(
    "div",
    { class: "card p-4 chart-card" },
    toggle === null ? null : h("div", { class: "d-flex flex-wrap align-items-center gap-4 mb-2" }, toggle),
    barChart({
      title,
      xs,
      groups,
      format: (v) => `${kind === "total" ? f.compactTokens(v) : f.tokens(v)} ${unit}`,
      axisFormat: f.compactTokens,
      period: "day",
    }),
  );
}

/** "Where did it go?": each harness, repository (worktrees folded in) or model, with token totals, largest first. */
function where(periods: readonly UsagePeriod[], state: UsageState, onChange: (next: UsageState) => void): HTMLElement {
  const sums = new Map<string, { tokens: number; harness: string | null }>();
  for (const p of periods) {
    for (const s of state.where === "harness" ? p.byHarness : state.where === "project" ? p.byProject : p.byModel) {
      const label = state.where === "harness" ? f.harness(s.harness) : state.where === "project" ? f.repository(s.project) : `${f.harness(s.harness)} · ${f.model(s.model, s.modelSource)}`;
      const entry = sums.get(label) ?? { tokens: 0, harness: state.where === "harness" ? s.harness : null };
      entry.tokens += all(s.figures);
      sums.set(label, entry);
    }
  }
  const rows = [...sums]
    .filter(([, r]) => r.tokens > 0)
    .map(([label, row]) => ({ label, ...row }))
    .sort((a, b) => b.tokens - a.tokens || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  const toggle = segmented(
    [
      ["harness", "By harness"],
      ["project", "By repository"],
      ["model", "By model"],
    ],
    state.where,
    (v) => onChange({ ...state, where: v as Where }),
  );
  return h(
    "div",
    {},
    h("div", { class: "d-flex flex-wrap align-items-center gap-4 mt-8 mb-3" }, h("h2", { class: "m-0" }, "Where did it go?"), toggle),
    rows.length === 0
      ? h("p", { class: "muted" }, "No calls in this range.")
      : h(
          "div",
          { class: "card p-5 shares" },
          rows.flatMap((r) => [
            h("span", { class: "share-label" }, r.label),
            // By harness, each bar wears its harness's chart color; otherwise the one default series color.
            h("progress", { class: r.harness === null ? "progress share" : `progress share ${HARNESS_COLOR[r.harness]?.slice(2) ?? ""}`, value: String(r.tokens), max: String(total || 1) }),
            h("span", { class: "num" }, share(r.tokens, total)),
            h("span", { class: "num", title: `${f.tokens(r.tokens)} tokens` }, f.compactTokens(r.tokens)),
          ]),
        ),
  );
}

/** Separate scales for the recorded token counts and the configured weighted load (R-16, R-33, R-51, ADR 0013). */
function measureCharts(periods: readonly (UsagePeriod | undefined)[], chart: UsageChart, projectFiltered = false): HTMLElement {
  // A running host can serve rebuilt UI files before its API code is restarted (ADR 0013).
  const weightedUnavailable = projectFiltered || periods.some((p) =>
    p !== undefined && (p.weightedTokenUnits === undefined || p.byHarness.some((s) => s.weightedTokenUnits === undefined)),
  );
  return h(
    "section",
    { class: "mt-8" },
    h("h2", { class: "mt-0" }, "Usage by token type"),
    h("p", { class: "muted small" }, "Charts sum recorded counts. Days with only unknown counts have no bar."),
    weightedUnavailable && !projectFiltered
      ? h("p", { class: "muted small" }, "Restart the dashboard server to load weighted token units.")
      : null,
    h(
      "div",
      { class: "charts d-grid gap-5" },
      chart("input", "Input tokens", "tokens", (t) => {
        const fields = [t.inputUncached, t.cacheRead, t.cacheWrite];
        return fields.every((field) => field.unknownCalls === t.calls) ? null : fields.reduce((sum, field) => sum + field.total, 0);
      }),
      chart("output", "Output tokens", "tokens", (t) => t.output.unknownCalls === t.calls ? null : t.output.total),
      weightedUnavailable
        ? null
        : chart("weighted", "Weighted token units", "weighted token units", (t, w) => w === undefined || w.unknownCalls === t.calls ? null : w.total),
    ),
  );
}

/** "YYYY-MM-DD" of an instant in the given time zone, the same calendar day USE-1 assigns calls to. */
function dayIn(epochMillis: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(epochMillis);
}

/** `length` calendar days ending `skip` days before `today`, oldest first. */
function lastDays(today: string, length: number, skip: number): string[] {
  const base = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Array.from({ length }, (_, i) => new Date(base - (skip + length - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}


/** A whole-number share; a non-zero share that rounds to 0 reads "<1%", never "0%". */
function share(part: number, whole: number): string {
  const percent = Math.round((part / whole) * 100);
  return percent === 0 && part > 0 ? "<1%" : `${percent}%`;
}
