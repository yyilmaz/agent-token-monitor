// Time-series bar charts with the vendored uPlot (ADR 0005). uPlot is loaded by index.html as a global script;
// only its types are imported here. Colors come from the page's CSS variables, so light and dark both apply.

import type uPlot from "../vendor/uplot/uPlot.js";
import { h } from "./dom.js";

const UPlot = (globalThis as unknown as { uPlot: typeof uPlot }).uPlot;

export interface Series {
  readonly title: string;
  /** Unix seconds of each period's start, ascending. */
  readonly xs: readonly number[];
  /** One series; ignored when `groups` is given. */
  readonly ys?: readonly (number | null)[];
  /** Several series drawn side by side in each period, each in its own CSS color variable; the legend toggles them. */
  readonly groups?: readonly Group[];
  readonly format: (value: number) => string;
  readonly axisFormat: (value: number) => string;
  /** "day" or "month": how the x axis and legend name a period. */
  readonly period: "day" | "month";
}

export interface Group {
  readonly label: string;
  /** A CSS custom property such as "--series-2"; it follows the entity, never its position (dataviz). */
  readonly colorVar: string;
  readonly ys: readonly (number | null)[];
}

interface Live {
  readonly element: HTMLElement;
  /** The latest series; the chart's formatters read it, so a reused chart formats new data correctly. */
  series: Series;
  chart: uPlot | null;
  data: string;
  used: boolean;
}

/**
 * Charts by title and period. A poll that renders the same chart again reuses it, so the reader's hover is not
 * lost every few seconds; only changed data is redrawn.
 */
const live = new Map<string, Live>();

/** Destroys the charts the last render did not use, so polling does not leak listeners. Call after each render. */
export function sweepCharts(): void {
  for (const [key, entry] of live) {
    if (entry.used) {
      entry.used = false;
      continue;
    }
    entry.chart?.destroy();
    live.delete(key);
  }
}

/**
 * Several series share one x array in uPlot, so side-by-side bars get their own x slot inside each period: series k
 * of n sits at `start + (k − (n − 1) / 2) × width`, with nulls in the other series' slots.
 */
function aligned(series: Series): { groups: readonly Group[]; data: uPlot.AlignedData; slot: number } {
  const groups = series.groups ?? [{ label: series.title, colorVar: "--series-1", ys: series.ys ?? [] }];
  const n = groups.length;
  const slot = n === 1 ? 0 : ((series.period === "day" ? 86_400 : 28 * 86_400) * 0.8) / n;
  const xs: number[] = [];
  const ys: (number | null)[][] = groups.map(() => []);
  series.xs.forEach((x, i) => {
    groups.forEach((g, k) => {
      xs.push(x + (k - (n - 1) / 2) * slot);
      groups.forEach((_, j) => (ys[j] as (number | null)[]).push(j === k ? (g.ys[i] ?? null) : null));
    });
  });
  return { groups, data: [xs, ...ys], slot };
}

/** A bar chart of one or more series; it is drawn once the element is in the page, at the element's width. */
export function barChart(series: Series): HTMLElement {
  const layout = aligned(series);
  // A different set of series is a different chart: uPlot cannot add or drop series in place.
  const key = `${series.period} ${series.title} ${layout.groups.map((g) => g.label).join("|")}`;
  const data = JSON.stringify(layout.data);
  const existing = live.get(key);
  if (existing) {
    existing.used = true;
    existing.series = series;
    if (existing.data !== data) {
      existing.data = data;
      existing.chart?.setData(layout.data);
    }
    return existing.element;
  }
  const entry: Live = { element: h("div", { class: "chart" }), series, chart: null, data, used: true };
  live.set(key, entry);
  requestAnimationFrame(() => {
    if (live.get(key) !== entry) return;
    // Never shown: forget it, so a later render builds a chart that does get drawn.
    if (!entry.element.isConnected) {
      live.delete(key);
      return;
    }
    const current = () => entry.series;
    const style = getComputedStyle(entry.element);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const axis = { stroke: color("--muted"), grid: { stroke: color("--border"), width: 1 }, ticks: { show: false } };
    const halfPeriod = (series.period === "day" ? 86_400 : 31 * 86_400) / 2;
    // Slots sit within ±0.4 period of the period's start, so rounding to the period recovers it.
    const periodOf = (seconds: number) => (series.period === "day" ? Math.round(seconds / 86_400) * 86_400 : seconds);
    const periodName = (seconds: number) => new Date(periodOf(seconds) * 1000).toISOString().slice(0, series.period === "day" ? 10 : 7);
    const single = layout.groups.length === 1;
    entry.chart = new UPlot(
      {
        title: series.title,
        width: Math.max(240, entry.element.clientWidth - 16),
        height: 180,
        // Periods are calendar dates already resolved in the configured time zone; draw them as UTC so they stay put.
        tzDate: (ts) => UPlot.tzDate(new Date(ts * 1000), "Etc/UTC"),
        cursor: { y: false, points: { show: false } },
        // Half a period of room on each side, so the first and last bars are drawn whole.
        scales: { x: { time: true, range: (_u, min, max) => [min - halfPeriod, max + halfPeriod] }, y: { range: (_u, _min, max) => [0, max > 0 ? max : 1] } },
        axes: [
          { ...axis, values: (_u, splits) => splits.map((s) => periodName(s).slice(series.period === "day" ? 5 : 0)) },
          { ...axis, size: 56, values: (_u, splits) => splits.map((s) => current().axisFormat(s)) },
        ],
        series: [
          { label: series.period === "day" ? "Day" : "Month", value: (_u, v) => (v === null ? "" : periodName(v)) },
          ...layout.groups.map((g, k) => ({
            label: g.label,
            fill: color(g.colorVar),
            stroke: color(g.colorVar),
            width: 0,
            // Side by side, each bar is nearly its whole slot, leaving a small gap to its neighbors.
            paths: (UPlot.paths.bars as NonNullable<typeof UPlot.paths.bars>)(single ? { size: [0.7, 24], radius: 0.15 } : { size: [0.85, 18], radius: 0.15, gap: 1 }),
            points: { show: false },
            // The legend shows every series' value for the hovered period, not only the bar under the cursor.
            value: (_u: uPlot, _v: number | null, _s: number, index: number | null) => {
              if (index === null) return "—";
              const now = current();
              const value = (now.groups?.[k]?.ys ?? now.ys ?? [])[Math.floor(index / layout.groups.length)];
              return value === null || value === undefined ? "—" : now.format(value);
            },
          })),
        ],
      },
      JSON.parse(entry.data) as uPlot.AlignedData,
      entry.element,
    );
  });
  return entry.element;
}
