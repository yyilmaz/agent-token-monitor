// View 2, "Usage": totals by day, month or session, split by harness, model or project (USE-1, R-33).
// Like a phone's battery screen: one number, one chart and where it went first; the full tables wait under "Details".

import type { UsageFigures, UsagePeriod, UsageSplit } from "../../../src/core/analysis/usage.js";
import type { usage } from "../../../src/core/api/index.js";
import type { CostTotal } from "../../../src/core/pricing/price.js";
import { barChart } from "../chart.js";
import { type Column, h, sessionLink, table } from "../dom.js";
import * as f from "../format.js";

type Usage = ReturnType<typeof usage>;
export type Split = "total" | "harness" | "model" | "project";
export type Where = "harness" | "project" | "model";

export type Metric = "tokens" | "usd";

export interface UsageState {
  readonly by: string;
  readonly split: Split;
  /** Index into `ui.usageRangesDays`. */
  readonly range: number;
  readonly where: Where;
  /** What the summary, the daily chart and "Where did it go?" measure. */
  readonly metric: Metric;
  /** The daily chart: one bar per harness side by side, or one total bar. */
  readonly chart: "harness" | "total";
}

interface Row {
  readonly period: string;
  readonly label: string;
  readonly figures: UsageFigures;
}

/** Each harness keeps its color wherever it appears, whatever is filtered (dataviz: color follows the entity). */
const HARNESS_COLOR: Readonly<Record<string, string>> = { claudeCode: "--series-1", antigravity: "--series-2", codex: "--series-3", opencode: "--series-4" };
const HARNESS_ORDER = ["claudeCode", "antigravity", "codex", "opencode"];

const all = (t: UsageFigures) => t.inputUncached.total + t.cacheRead.total + t.cacheWrite.total + t.output.total;

/** `days` is always the daily payload; `detail` is the payload the Details table asked for (day, month or session). */
export function renderUsage(days: Usage, detail: Usage, state: UsageState, onChange: (next: UsageState) => void): HTMLElement {
  const decimals = days.configuration.pricing.displayDecimals;
  const ranges = days.configuration.ui.usageRangesDays;
  const range = Math.min(state.range, ranges.length - 1);
  const length = ranges[range] as number;
  const today = dayIn(days.asOf, days.timeZone);
  const current = lastDays(today, length, 0);
  const before = lastDays(today, length, length);
  const byDay = new Map(days.periods.map((p) => [p.period, p]));
  const inRange = current.map((d) => byDay.get(d)).filter((p): p is UsagePeriod => p !== undefined);
  const previous = before.map((d) => byDay.get(d)).filter((p): p is UsagePeriod => p !== undefined);

  const rangeButtons = segmented(
    ranges.map((n, i) => [String(i), `Last ${n} days`]),
    String(range),
    (v) => onChange({ ...state, range: Number(v) }),
  );
  const metricButtons = segmented(
    [
      ["tokens", "Tokens"],
      ["usd", days.configuration.pricing.currency],
    ],
    state.metric,
    (v) => onChange({ ...state, metric: v as Metric }),
  );

  return h(
    "div",
    {},
    h("div", { class: "controls" }, rangeButtons, metricButtons, sources(days.sources)),
    h(
      "div",
      { class: "usage-top" },
      summary(inRange, previous, length, state.metric, decimals, days.configuration.pricing.currency),
      dailyChart(current, byDay, state, onChange, days.configuration.pricing.currency, decimals),
    ),
    where(inRange, state, onChange, decimals, days.configuration.pricing.currency),
    h(
      "details",
      { class: "usage-details" },
      h("summary", {}, "Details: every day, month or session, by token type"),
      details(detail, state, onChange),
    ),
  );
}

function segmented(options: readonly (readonly [string, string])[], value: string, change: (value: string) => void): HTMLElement {
  return h(
    "div",
    { class: "segmented" },
    options.map(([v, label]) => {
      const button = h("button", v === value ? { type: "button", "aria-pressed": "true" } : { type: "button" }, label);
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
    { class: "sources small" },
    read.length === 0 ? null : h("span", {}, h("span", { class: "dot good" }, "●"), " Counting ", h("strong", {}, names(read))),
    waiting.length === 0 ? null : h("span", { class: "muted", title: "Their logs are on this computer, but their adapters come in Phase 2 (R-21)" }, h("span", { class: "dot" }, "○"), " Found, not counted yet: ", names(waiting)),
  );
}

/** Exact sum of cost totals (ADR 0011), and whether some calls in them had no price. */
interface MoneySum {
  readonly units: bigint;
  readonly priced: boolean;
  readonly incomplete: boolean;
}

function sumOf(costs: readonly CostTotal[]): MoneySum {
  return {
    units: costs.filter((c) => c.pricedCalls > 0).reduce((a, c) => a + BigInt(c.known.total.replace(".", "")), 0n),
    priced: costs.some((c) => c.pricedCalls > 0),
    incomplete: costs.some((c) => c.incomplete),
  };
}

function moneyText(sum: MoneySum, decimals: number, currency: string): string {
  if (!sum.priced) return "no price";
  const digits = sum.units.toString().padStart(13, "0");
  return f.money(`${digits.slice(0, -12)}.${digits.slice(-12)}`, decimals, currency);
}

/** The one big number in the chosen metric, how it compares with the same number of days before, and the cache's share of the input. */
function summary(periods: readonly UsagePeriod[], before: readonly UsagePeriod[], length: number, metric: Metric, decimals: number, currency: string): HTMLElement {
  const tokens = periods.reduce((a, p) => a + all(p.total), 0);
  const cost = sumOf(periods.map((p) => p.total.cost));
  const usd = metric === "usd";
  // Compared in the shown metric; money as exact units, tokens as counts.
  const now = usd ? Number(cost.units) : tokens;
  const then = usd ? Number(sumOf(before.map((p) => p.total.cost)).units) : before.reduce((a, p) => a + all(p.total), 0);
  const read = periods.reduce((a, p) => a + p.total.cacheRead.total, 0);
  const input = periods.reduce((a, p) => a + p.total.inputUncached.total + p.total.cacheRead.total + p.total.cacheWrite.total, 0);
  const unknown = periods.reduce((a, p) => a + Math.max(p.total.inputUncached.unknownCalls, p.total.cacheRead.unknownCalls, p.total.cacheWrite.unknownCalls, p.total.output.unknownCalls), 0);
  const change =
    then === 0
      ? h("span", { class: "muted" }, `nothing in the ${length} days before`)
      : now === then
        ? h("span", { class: "badge" }, `same as the ${length} days before`)
        : h("span", { class: "badge" }, `${now > then ? "↑" : "↓"} ${((Math.abs(now - then) / then) * 100).toFixed(0)}% vs the ${length} days before`);
  const tokensLine = h("span", { title: `${f.tokens(tokens)} tokens` }, `${f.compactTokens(tokens)} tokens`);
  const moneyLine = `${moneyText(cost, decimals, currency)}${cost.incomplete ? " (incomplete: some calls have no price)" : ""} at API list price (not your bill)`;
  return h(
    "div",
    { class: "card hero" },
    h("div", { class: "label" }, usd ? `Spent at API list price, last ${length} days` : `Tokens used, last ${length} days`),
    h("div", { class: "big", title: usd ? moneyLine : `${f.tokens(tokens)} tokens` }, usd ? moneyText(cost, decimals, currency) : f.compactTokens(tokens)),
    h("div", {}, change),
    h("div", { class: "muted small" }, usd ? [tokensLine, cost.incomplete ? " · incomplete: some calls have no price" : "", " · not your bill"] : moneyLine),
    input === 0
      ? null
      : h(
          "p",
          { class: "efficiency", title: "Cache read ÷ all input (uncached + cache read + cache write)" },
          h("strong", {}, `${((read / input) * 100).toFixed(1)}%`),
          " of the input came from the cache, at the cheap price.",
        ),
    unknown === 0 ? null : h("div", { class: "muted small" }, `Up to ${f.tokens(unknown)} calls did not log every count and are left out.`),
  );
}

/**
 * Tokens or money per day over the range: one bar per harness side by side, or one total bar. The legend under the
 * chart turns a harness on or off. Days without calls show as empty slots, not as gaps in the axis.
 */
function dailyChart(dates: readonly string[], byDay: ReadonlyMap<string, UsagePeriod>, state: UsageState, onChange: (next: UsageState) => void, currency: string, decimals: number): HTMLElement {
  const usd = state.metric === "usd";
  const value = (figures: UsageFigures | undefined): number | null => {
    if (figures === undefined) return usd ? null : 0;
    // Display only: exact amounts stay in the tables (ADR 0011).
    return usd ? (figures.cost.pricedCalls > 0 ? Number(figures.cost.known.total) : null) : all(figures);
  };
  const periods = dates.map((d) => byDay.get(d));
  const harnesses = HARNESS_ORDER.filter((id) => periods.some((p) => p?.byHarness.some((s) => s.harness === id && all(s.figures) > 0)));
  const groups =
    state.chart === "total"
      ? [{ label: "All harnesses", colorVar: "--series-1", ys: periods.map((p) => value(p?.total)) }]
      : harnesses.map((id) => ({ label: f.harness(id), colorVar: HARNESS_COLOR[id] as string, ys: periods.map((p) => value(p?.byHarness.find((s) => s.harness === id)?.figures)) }));
  const toggle = segmented(
    [
      ["harness", "Per harness"],
      ["total", "Total"],
    ],
    state.chart,
    (v) => onChange({ ...state, chart: v as UsageState["chart"] }),
  );
  return h(
    "div",
    { class: "chart-card" },
    h("div", { class: "chart-head" }, toggle, usd && groups.some((g) => g.ys.every((v) => v === null)) ? h("span", { class: "muted small" }, "A harness with no bars has no price.") : null),
    barChart({
      title: usd ? `${currency} per day, API list price` : "Tokens per day",
      xs: dates.map((d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 1000),
      groups,
      format: usd ? (v) => `${v.toFixed(decimals)} ${currency}` : (v) => `${f.compactTokens(v)} tokens`,
      axisFormat: usd ? (v) => v.toFixed(v < 10 ? 1 : 0) : f.compactTokens,
      period: "day",
    }),
  );
}

/** "Where did it go?": each harness, repository (worktrees folded in) or model, with tokens and money, largest first in the chosen metric. */
function where(periods: readonly UsagePeriod[], state: UsageState, onChange: (next: UsageState) => void, decimals: number, currency: string): HTMLElement {
  const sums = new Map<string, { tokens: number; costs: CostTotal[]; harness: string | null }>();
  for (const p of periods) {
    for (const s of state.where === "harness" ? p.byHarness : state.where === "project" ? p.byProject : p.byModel) {
      const label = state.where === "harness" ? f.harness(s.harness) : state.where === "project" ? f.repository(s.project) : `${f.harness(s.harness)} · ${f.model(s.model, s.modelSource)}`;
      const entry = sums.get(label) ?? { tokens: 0, costs: [], harness: state.where === "harness" ? s.harness : null };
      entry.tokens += all(s.figures);
      entry.costs.push(s.figures.cost);
      sums.set(label, entry);
    }
  }
  const usd = state.metric === "usd";
  const rows = [...sums]
    .filter(([, r]) => r.tokens > 0)
    .map(([label, r]) => ({ label, tokens: r.tokens, money: sumOf(r.costs), harness: r.harness }))
    .map((r) => ({ ...r, measure: usd ? Number(r.money.units) : r.tokens }))
    // Largest first in the shown metric; ties (e.g. no price) by tokens, then by name.
    .sort((a, b) => b.measure - a.measure || b.tokens - a.tokens || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const total = rows.reduce((a, r) => a + r.measure, 0);
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
    h("div", { class: "section-head" }, h("h2", {}, "Where did it go?"), toggle),
    rows.length === 0
      ? h("p", { class: "muted" }, "No calls in this range.")
      : h(
          "div",
          { class: "card shares" },
          rows.flatMap((r) => [
            h("span", { class: "share-label" }, r.label),
            // By harness, each bar wears its harness's chart color; otherwise the one default series color.
            h("progress", { class: r.harness === null ? "share" : `share ${HARNESS_COLOR[r.harness]?.slice(2) ?? ""}`, value: String(r.measure), max: String(total || 1) }),
            h("span", { class: "num" }, usd && !r.money.priced ? "—" : share(r.measure, total)),
            h("span", { class: `num ${usd ? "" : "muted small"}`, title: r.money.incomplete ? "Some calls here have no price" : "" }, moneyText(r.money, decimals, currency) + (r.money.priced && r.money.incomplete ? "*" : "")),
            h("span", { class: `num ${usd ? "muted small" : ""}`, title: `${f.tokens(r.tokens)} tokens` }, f.compactTokens(r.tokens)),
          ]),
        ),
  );
}

function details(data: Usage, state: UsageState, onChange: (next: UsageState) => void): HTMLElement {
  const decimals = data.configuration.pricing.displayDecimals;
  const split = state.split;
  const select = (name: string, value: string, options: readonly [string, string][], change: (v: string) => void) => {
    const element = h("select", { "aria-label": name }, options.map(([v, label]) => h("option", v === value ? { value: v, selected: "" } : { value: v }, label)));
    element.addEventListener("change", () => change(element.value));
    return element;
  };

  const rows: Row[] = [...data.periods].reverse().flatMap((p: UsagePeriod) => {
    if (split === "total") return [{ period: p.period, label: "", figures: p.total }];
    const parts: readonly UsageSplit[] = split === "harness" ? p.byHarness : split === "model" ? p.byModel : p.byProject;
    return parts.map((s) => ({
      period: p.period,
      label: split === "harness" ? f.harness(s.harness) : split === "model" ? `${f.harness(s.harness)} · ${f.model(s.model, s.modelSource)}` : f.project(s.project),
      figures: s.figures,
    }));
  });

  // Short counts, exact on hover; calls whose count is unknown are named, never folded in (R-16).
  const sum = (n: { total: number; unknownCalls: number }) =>
    h(
      "span",
      { title: `${f.tokens(n.total)} tokens` + (n.unknownCalls > 0 ? `, plus ${n.unknownCalls} calls whose count is unknown` : "") },
      f.compactTokens(n.total),
      n.unknownCalls > 0 ? h("span", { class: "muted small" }, " +?") : null,
    );
  const columns: Column<Row>[] = [
    { title: data.by === "session" ? "Session" : data.by === "day" ? "Day" : "Month", cell: (r) => (data.by === "session" ? sessionLink(r.period) : r.period) },
    ...(split === "total" ? [] : [{ title: split[0]?.toUpperCase() + split.slice(1), cell: (r: Row) => r.label }]),
    { title: "Calls", numeric: true, cell: (r) => f.tokens(r.figures.calls) },
    { title: "Total tokens", numeric: true, cell: (r) => h("strong", {}, f.tokensShort(all(r.figures))) },
    { title: "Read from cache (cheap)", numeric: true, cell: (r) => sum(r.figures.cacheRead) },
    { title: "Written to cache", numeric: true, cell: (r) => sum(r.figures.cacheWrite) },
    { title: "New input (full price)", numeric: true, cell: (r) => sum(r.figures.inputUncached) },
    { title: "Output", numeric: true, cell: (r) => sum(r.figures.output) },
    { title: "At API list price", numeric: true, cell: (r) => f.cost(r.figures.cost, decimals) },
  ];

  return h(
    "div",
    {},
    h(
      "div",
      { class: "controls" },
      select("Period", data.by, [["day", "By day"], ["month", "By month"], ["session", "By session"]], (v) => onChange({ ...state, by: v })),
      select("Split", split, [["total", "Total"], ["harness", "By harness"], ["model", "By model"], ["project", "By project"]], (v) => onChange({ ...state, split: v as Split })),
      h("span", { class: "muted small", title: `USE-1 · days in ${data.timeZone}` }, "+? means some calls did not log that number; hover for how many."),
    ),
    data.by === "session" ? null : charts(data, decimals),
    table(columns, rows),
  );
}

/** One chart per measure: their sizes differ by orders of magnitude, so they never share an axis. */
function charts(data: Usage, decimals: number): HTMLElement {
  const period = data.by === "day" ? "day" : "month";
  const xs = data.periods.map((p) => Date.UTC(Number(p.period.slice(0, 4)), Number(p.period.slice(5, 7)) - 1, period === "day" ? Number(p.period.slice(8, 10)) : 1) / 1000);
  const tokenChart = (title: string, pick: (t: UsageFigures) => { total: number }) =>
    barChart({ title: `${title}, tokens`, xs, ys: data.periods.map((p) => pick(p.total).total), format: f.tokens, axisFormat: f.compactTokens, period });
  const priced = data.periods.some((p) => p.total.cost.pricedCalls > 0);
  const currency = data.periods[0]?.total.cost.currency ?? "";
  return h(
    "div",
    { class: "charts" },
    tokenChart("Read from cache (cheap)", (t) => t.cacheRead),
    tokenChart("Written to cache", (t) => t.cacheWrite),
    tokenChart("New input (full price)", (t) => t.inputUncached),
    tokenChart("Output", (t) => t.output),
    priced
      ? barChart({
          title: `At API list price, ${currency} (not your bill)`,
          xs,
          // Display only: the exact amounts stay in the table (ADR 0011).
          ys: data.periods.map((p) => (p.total.cost.pricedCalls > 0 ? Number(p.total.cost.known.total) : null)),
          format: (v) => v.toFixed(decimals),
          axisFormat: (v) => v.toFixed(decimals),
          period,
        })
      : null,
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
