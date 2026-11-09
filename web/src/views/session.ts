// Session drill-down: weighted step load cards, subagent comparison, and step-by-step timeline (R-17, ADR 0013, ADR 0017).

import type { CacheClass, MissCauseKind } from "../../../src/core/analysis/cache.js";
import type { session } from "../../../src/core/api/index.js";
import { card, h, sessionLink, svg, table } from "../dom.js";
import * as f from "../format.js";

type SessionData = NonNullable<ReturnType<typeof session>>;
type Row = SessionData["calls"][number];

/** Each cache class (CLS-1) in words, with a badge tone. */
const CLASS: Readonly<Record<CacheClass, readonly [string, string]>> = {
  hit: ["kept", "good"],
  partial: ["partly kept", "warn"],
  fullMiss: ["missed", "bad"],
  first: ["first call", ""],
  belowThreshold: ["too small to cache", ""],
  unknown: ["unknown", ""],
};

let trajectoryExpanded = false;

export function renderSession(data: SessionData): HTMLElement {
  const s = data.session;
  const w = data.weighted;
  const weights = w.weights;
  const recentWindow = w.recentTurnsWindow;
  const contextOf = (r: Row) =>
    r.call.inputUncached === null || r.call.cacheRead === null || r.call.cacheWrite === null ? null : r.call.inputUncached + r.call.cacheRead + r.call.cacheWrite;

  const turnRows = data.calls.filter((r) => r.call.kind === "turn");
  let totalCacheRead = 0;
  let lossCount = 0;
  let totalReRead = 0;
  const lossCauses = new Map<MissCauseKind, number>();

  for (const r of data.calls) {
    totalCacheRead += r.call.cacheRead ?? 0;
    if (r.cache?.cacheLoss) {
      lossCount += 1;
      totalReRead += r.cache.reReadTokens ?? 0;
      const cause = r.cache.cause?.cause;
      if (cause !== undefined) lossCauses.set(cause, (lossCauses.get(cause) ?? 0) + 1);
    }
  }

  const cacheSavedUnits = Math.max(0, Math.round(totalCacheRead * (weights.inputUncached - weights.cacheRead)));
  const topCauseSummary = [...lossCauses.entries()].map(([cause, count]) => `${f.CAUSE[cause][0]} (${count}×)`).join(", ");

  // Trend of recent N steps vs. active window average since last compaction.
  let trendNote = "Not enough steps in active window";
  if (w.recentAvgWeightedTokens !== null && w.activeWindowAvgWeightedTokens !== null && w.activeWindowAvgWeightedTokens > 0) {
    const diffPct = Math.round(((w.recentAvgWeightedTokens - w.activeWindowAvgWeightedTokens) / w.activeWindowAvgWeightedTokens) * 100);
    if (Math.abs(diffPct) <= 5) trendNote = `Recent ${recentWindow}-step load matches window avg`;
    else if (diffPct > 0) trendNote = `Recent ${recentWindow} steps: +${diffPct}% above window avg (growing)`;
    else trendNote = `Recent ${recentWindow} steps: −${Math.abs(diffPct)}% below window avg`;
  }

  // Precompute context deltas and 1-based step numbers before reversing to newest-first.
  let prevContext: number | null = null;
  const deltas = new Map<string, number | null>();
  const stepNumbers = new Map<string, number>();
  data.calls.forEach((r, idx) => {
    stepNumbers.set(r.call.id, idx + 1);
    const cur = contextOf(r);
    deltas.set(r.call.id, cur !== null && prevContext !== null ? cur - prevContext : null);
    if (cur !== null) prevContext = cur;
  });
  const newestFirstCalls = [...data.calls].reverse();

  const displayTitle = s.title ?? (s.projectPath !== null ? f.project(s.projectPath) : f.shortSessionId(s.id, s.isSubagent));
  const sessionModel = turnRows[0] === undefined ? null : f.model(turnRows[0].model, turnRows[0].modelSource);

  const trajectoryHost = h("div", {});
  const toggleHint = h("span", { class: "expand-hint" }, trajectoryExpanded ? "⤡ Hide chart" : "⤢ Expand chart");
  const activeWindowCard = card(
    "Active window avg",
    w.activeWindowAvgWeightedTokens === null ? "unknown" : `${f.compactTokens(w.activeWindowAvgWeightedTokens)} / step`,
    renderActiveWindowMini(data.calls, stepNumbers, w.activeWindowAvgWeightedTokens, toggleHint),
    `${w.activeTurns} ${w.activeTurns === 1 ? "step" : "steps"} ${
      w.compactions > 0 ? `since last compact (${w.compactions} total)` : "in session (no compactions)"
    }`,
    trendNote,
  );
  activeWindowCard.classList.add("expandable-card");
  activeWindowCard.setAttribute("role", "button");
  activeWindowCard.setAttribute("tabindex", "0");
  activeWindowCard.setAttribute("aria-expanded", String(trajectoryExpanded));

  const syncExpandedTrajectory = () => {
    activeWindowCard.classList.toggle("is-expanded", trajectoryExpanded);
    activeWindowCard.setAttribute("aria-expanded", String(trajectoryExpanded));
    toggleHint.textContent = trajectoryExpanded ? "⤡ Hide chart" : "⤢ Expand chart";
    trajectoryHost.replaceChildren();
    if (trajectoryExpanded) {
      const panel = renderExpandedTrajectory(data, stepNumbers, deltas, contextOf, () => {
        trajectoryExpanded = false;
        syncExpandedTrajectory();
      });
      if (panel !== null) trajectoryHost.append(panel);
    }
  };

  const toggleTrajectory = () => {
    trajectoryExpanded = !trajectoryExpanded;
    syncExpandedTrajectory();
  };
  activeWindowCard.addEventListener("click", toggleTrajectory);
  activeWindowCard.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleTrajectory();
    }
  });
  syncExpandedTrajectory();

  return h(
    "div",
    {},
    h("p", { class: "small" }, h("a", { href: "#now" }, "← Back to Now")),
    h("h2", {}, displayTitle),
    h(
      "p",
      { class: "muted small" },
      `${f.harness(s.harness)}${sessionModel === null ? "" : ` · ${sessionModel}`} · ${s.id}`,
      s.projectPath === null ? null : ` · project: ${s.projectPath}`,
      s.parentSessionId === null
        ? null
        : h("span", {}, " · subagent of ", sessionLink(s.parentSessionId, data.titles[s.parentSessionId] ?? f.shortSessionId(s.parentSessionId))),
      s.spawnedBySessionId === null
        ? null
        : h("span", {}, " · started by ", sessionLink(s.spawnedBySessionId, data.titles[s.spawnedBySessionId] ?? f.shortSessionId(s.spawnedBySessionId))),
    ),
    data.sideSessions.length > 0
      ? h(
          "p",
          { class: "small" },
          "Side sessions: ",
          data.sideSessions.flatMap((c, i) => [i > 0 ? ", " : "", sessionLink(c.id, c.title ?? f.shortSessionId(c.id))]),
        )
      : null,
    data.children.length > 0 ? subagentTable(data) : null,
    h(
      "div",
      { class: "cards" },
      card(
        `Recent step load (last ${recentWindow})`,
        w.recentAvgWeightedTokens === null ? "unknown" : `${f.compactTokens(w.recentAvgWeightedTokens)} / step`,
        renderRecentStepsMini(data.calls, stepNumbers, w.activeWindowAvgWeightedTokens),
        `Latest step: ${f.compactTokens(w.lastStepWeightedTokens)} weighted units`,
        `Weights: ${weights.cacheRead}× cache · ${weights.inputUncached}× new · ${weights.cacheWrite}× write · ${weights.output}× output`,
      ),
      activeWindowCard,
      card(
        "Total weighted load",
        `${f.compactTokens(w.combinedWeightedTokens)} units`,
        renderWeightedBreakdownMini(data.calls, weights, w.subagentWeightedTokens),
        w.subagentCount > 0
          ? `Main ${f.compactTokens(w.sessionWeightedTokens)} + subagents ${f.compactTokens(w.subagentWeightedTokens)}`
          : `All-time avg: ${f.compactTokens(w.allTimeAvgWeightedTokens)} / step (${w.totalTurns} steps)`,
        w.subagentCount > 0
          ? `All-time main avg: ${f.compactTokens(w.allTimeAvgWeightedTokens)} / step (${w.totalTurns} steps)`
          : "No subagents spawned in this session",
      ),
      card(
        "Subagent & cache efficiency",
        w.subagentCount > 0 ? `${f.compactTokens(w.subagentAvgWeightedTokens)} / subagent step` : `Saved ${f.compactTokens(cacheSavedUnits)} units`,
        renderEfficiencyMini(data.calls, w, cacheSavedUnits),
        w.subagentCount > 0
          ? `${w.subagentCount} ${w.subagentCount === 1 ? "subagent" : "subagents"} (${w.subagentTurns} steps) vs. main ${f.compactTokens(w.activeWindowAvgWeightedTokens)} / step`
          : `Cache reduced input load by ${f.compactTokens(cacheSavedUnits)} weighted units`,
        lossCount === 0
          ? "0 cache losses (0 units paid again)"
          : `${lossCount} cache ${lossCount === 1 ? "loss" : "losses"} (${f.compactTokens(totalReRead)} paid again · ${topCauseSummary})`,
      ),
    ),
    trajectoryHost,
    h("h2", {}, "Step-by-step timeline"),
    table(
      [
        {
          title: "#",
          help: "Step number in this session (newest step at the top). Hover a row number to see the exact log file and line (R-17).",
          numeric: true,
          cell: (r: Row) => {
            const stepNo = stepNumbers.get(r.call.id) ?? 0;
            return h(
              "span",
              {
                "data-step-row": String(stepNo),
                title: r.call.sources.map((src) => `${src.file}:${src.line}`).join(", "),
              },
              String(stepNo),
            );
          },
        },
        {
          title: "Time",
          help: "Timestamp recorded in the harness log for this step.",
          cell: (r) => f.time(r.call.timestamp, data.timeZone),
        },
        {
          title: "Pause",
          help: "Idle gap since the previous turn in this session (PAIR-1). Long pauses risk expiring the prompt cache.",
          numeric: true,
          cell: (r) => (r.cache === null || r.cache.gapSeconds === null ? "—" : f.duration(r.cache.gapSeconds)),
        },
        {
          title: "Actions / Tools",
          help: "Tools invoked by the model on this turn (edit, read/search, command, subagent), or compaction.",
          cell: (r) => renderTools(r),
        },
        {
          title: "Context",
          help: "Summary (not billed extra): total input context sent on this step (Context = From cache + Cache write + New input), and change from the previous step.",
          numeric: true,
          cell: (r) => {
            const ctx = contextOf(r);
            const delta = deltas.get(r.call.id) ?? null;
            const deltaText =
              delta === null || delta === 0
                ? null
                : h("span", { class: "muted small" }, ` (${delta > 0 ? "+" : "−"}${f.compactTokens(Math.abs(delta))})`);
            return h("span", {}, f.tokensShort(ctx), deltaText);
          },
        },
        {
          title: "Cache",
          help: "How much of the previous step's context was read from cache (CLS-1): kept (full hit), partly kept (≥75% kept), or lost (<75% kept).",
          cell: (r) => {
            if (r.cache === null) return "";
            const [baseText, tone] = r.cache.cacheLoss ? (["lost", "bad"] as const) : CLASS[r.cache.class];
            const ctx = contextOf(r);
            const eligible = r.cache.prefixTokens !== null && ctx !== null ? Math.min(r.cache.prefixTokens, ctx) : null;
            const pct =
              eligible !== null && eligible > 0 && r.call.cacheRead !== null && (r.cache.class === "hit" || r.cache.class === "partial" || r.cache.class === "fullMiss")
                ? ` (${Math.min(100, Math.round((r.call.cacheRead / eligible) * 100))}%)`
                : "";
            const tooltip =
              eligible !== null && r.call.cacheRead !== null
                ? `CLS-1 · ${r.cache.class} · read ${f.tokens(r.call.cacheRead)} of ${f.tokens(eligible)} prior context (${f.tokens(r.cache.reReadTokens)} paid again)`
                : `CLS-1 · ${r.cache.class}`;
            const cause = r.cache.cause?.cause;
            const causeText = cause === undefined ? null : h("span", { class: "muted small", title: f.CAUSE[cause][1] }, ` · ${f.CAUSE[cause][0]}`);
            return h("span", {}, h("span", { class: `badge ${tone}`, title: tooltip }, `${baseText}${pct}`), causeText);
          },
        },
        {
          title: "From cache",
          help: "Billed (discounted rate, ~5–10% of normal input): tokens read directly from the provider's prompt cache.",
          numeric: true,
          cell: (r) => f.tokensShort(r.call.cacheRead),
        },
        {
          title: "Cache write",
          help: "Billed (cache-write rate, 1.25×–2× normal input): tokens newly written into the prompt cache. Antigravity logs 0 here and counts them under New input.",
          numeric: true,
          cell: (r) => f.tokensShort(r.call.cacheWrite),
        },
        {
          title: "New input",
          help: "Billed (full 1× input rate): uncached input tokens sent on this step.",
          numeric: true,
          cell: (r) => f.tokensShort(r.call.inputUncached),
        },
        {
          title: "Paid again",
          help: "Analytical breakdown (not billed extra): portion of New input / Cache write that was already in the previous step's context but missed the cache and had to be paid at full price again (reReadTokens).",
          numeric: true,
          cell: (r) => (r.cache === null || r.cache.reReadTokens === null || r.cache.reReadTokens === 0 ? "—" : f.tokensShort(r.cache.reReadTokens)),
        },
        {
          title: "Output",
          help: "Billed (full output rate, ~5× input rate): tokens generated by the model on this step.",
          numeric: true,
          cell: (r) => f.tokensShort(r.call.output),
        },
        {
          title: "Weighted",
          help: `Weighted step load = ${weights.cacheRead}×From cache + ${weights.cacheWrite}×Cache write + ${weights.inputUncached}×New input + ${weights.output}×Output. Lets you compare step cost across turns, compactions and subagents.`,
          numeric: true,
          cell: (r) =>
            r.weightedTokens === null
              ? "—"
              : h("strong", { title: `${f.tokens(r.weightedTokens)} weighted units` }, f.compactTokens(r.weightedTokens)),
        },
      ],
      newestFirstCalls,
      "Nothing to show.",
      (r) => (r.call.kind === "compaction" ? "compaction-row" : r.cache?.cacheLoss ? "loss-row" : null),
      "session-timeline",
    ),
  );
}

function renderTools(r: Row): HTMLElement {
  if (r.call.kind === "compaction") return h("span", { class: "badge warn" }, "compaction");
  if (r.call.toolNames.length === 0) return h("span", { class: "muted small" }, "reply only");
  return h(
    "div",
    { class: "tools-cell" },
    r.call.toolNames.map((name) => h("span", { class: "tool-tag" }, name)),
  );
}

/** Card 1 mini chart: vertical bar chart of the last 10 steps' weighted loads vs. active window average. */
function renderRecentStepsMini(calls: readonly Row[], stepNumbers: ReadonlyMap<string, number>, windowAvg: number | null): HTMLElement | null {
  const recent = calls.slice(-10);
  if (recent.length === 0) return null;
  const values = recent.map((r) => r.weightedTokens ?? 0);
  const maxVal = Math.max(...values, windowAvg ?? 0, 1);
  const width = 220;
  const height = 36;
  const slotWidth = width / 10;
  const barWidth = Math.max(8, Math.floor(slotWidth - 5));
  const offsetSlots = 10 - recent.length;

  const bars = recent.map((r, i) => {
    const val = r.weightedTokens ?? 0;
    const hPx = val > 0 ? Math.max(3, Math.round((val / maxVal) * (height - 4))) : 2;
    const x = Math.round((offsetSlots + i) * slotWidth + 2);
    const y = height - hPx;
    const stepNo = stepNumbers.get(r.call.id) ?? i + 1;
    const isLast = i === recent.length - 1;
    const cls =
      r.call.kind === "compaction"
        ? "mini-bar warn"
        : r.cache?.cacheLoss
          ? "mini-bar bad"
          : isLast
            ? "mini-bar latest"
            : "mini-bar";
    const note = r.call.kind === "compaction" ? " (compaction)" : r.cache?.cacheLoss ? " (cache loss)" : isLast ? " (latest)" : "";
    return svg(
      "rect",
      { class: cls, x, y, width: barWidth, height: hPx, rx: 2 },
      svg("title", {}, `Step #${stepNo}: ${f.compactTokens(r.weightedTokens)} weighted units${note}`),
    );
  });

  const avgY = windowAvg !== null && windowAvg > 0 ? Math.max(2, Math.min(height - 2, Math.round(height - (windowAvg / maxVal) * (height - 4)))) : null;
  const avgLine =
    avgY === null
      ? null
      : svg(
          "line",
          { class: "mini-ref-line", x1: 0, y1: avgY, x2: width, y2: avgY, "stroke-dasharray": "3 3" },
          svg("title", {}, `Active window avg: ${f.compactTokens(windowAvg)} / step`),
        );

  return h("div", { class: "mini-viz" }, svg("svg", { class: "mini-svg", viewBox: `0 0 ${width} ${height}`, role: "img" }, bars, avgLine));
}

/** Card 2 mini chart: full-session sparkline of step weighted loads with vertical compaction markers and active window average line. */
function renderActiveWindowMini(
  calls: readonly Row[],
  stepNumbers: ReadonlyMap<string, number>,
  windowAvg: number | null,
  toggleHint?: HTMLElement,
): HTMLElement | null {
  if (calls.length === 0) return null;
  const width = 220;
  const height = 36;
  const padY = 3;
  const usableH = height - padY * 2;
  const values = calls.map((r) => r.weightedTokens ?? 0);
  const maxVal = Math.max(...values, windowAvg ?? 0, 1);
  const xOf = (idx: number) => (calls.length === 1 ? Math.round(width / 2) : Math.round((idx / (calls.length - 1)) * (width - 4) + 2));
  const yOf = (val: number) => Math.round(height - padY - (val / maxVal) * usableH);

  const pts = calls.map((r, i) => `${xOf(i)},${yOf(r.weightedTokens ?? 0)}`).join(" ");
  const areaPts =
    calls.length > 1 ? `${xOf(0)},${height - 1} ${pts} ${xOf(calls.length - 1)},${height - 1}` : null;

  let lastCompactIdx = -1;
  const compactLines = calls.flatMap((r, i) => {
    if (r.call.kind !== "compaction") return [];
    lastCompactIdx = i;
    const x = xOf(i);
    const stepNo = stepNumbers.get(r.call.id) ?? i + 1;
    return [
      svg(
        "line",
        { class: "mini-compact-line", x1: x, y1: 1, x2: x, y2: height - 1, "stroke-dasharray": "2 2" },
        svg("title", {}, `Compaction at step #${stepNo}`),
      ),
    ];
  });

  const avgY = windowAvg !== null && windowAvg > 0 ? yOf(windowAvg) : null;
  const avgStartX = lastCompactIdx >= 0 ? xOf(lastCompactIdx) : 0;
  const avgLine =
    avgY === null
      ? null
      : svg(
          "line",
          { class: "mini-ref-line", x1: avgStartX, y1: avgY, x2: width, y2: avgY, "stroke-dasharray": "3 3" },
          svg("title", {}, `Active window avg: ${f.compactTokens(windowAvg)} / step`),
        );

  const lastIdx = calls.length - 1;
  const lastRow = calls[lastIdx];
  const endDot =
    lastRow === undefined
      ? null
      : svg(
          "circle",
          { class: "mini-dot", cx: xOf(lastIdx), cy: yOf(lastRow.weightedTokens ?? 0), r: 2.5 },
          svg("title", {}, `Latest step #${stepNumbers.get(lastRow.call.id) ?? calls.length}: ${f.compactTokens(lastRow.weightedTokens)} units`),
        );

  return h(
    "div",
    { class: "mini-viz" },
    svg(
      "svg",
      { class: "mini-svg", viewBox: `0 0 ${width} ${height}`, role: "img" },
      areaPts === null ? null : svg("polygon", { class: "mini-area", points: areaPts }),
      calls.length > 1 ? svg("polyline", { class: "mini-line", points: pts }) : null,
      compactLines,
      avgLine,
      endDot,
    ),
    toggleHint ?? null,
  );
}

/** Expanded full-width interactive trajectory chart toggled by clicking the Active window avg card. */
function renderExpandedTrajectory(
  data: SessionData,
  stepNumbers: ReadonlyMap<string, number>,
  deltas: ReadonlyMap<string, number | null>,
  contextOf: (r: Row) => number | null,
  onClose: () => void,
): HTMLElement | null {
  const calls = data.calls;
  if (calls.length === 0) return null;
  const w = data.weighted;
  const weights = w.weights;

  const width = 920;
  const height = 250;
  const padL = 56;
  const padR = 20;
  const padT = 22;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const bottomY = padT + plotH;

  const values = calls.map((r) => r.weightedTokens ?? 0);
  const maxVal = Math.max(...values, w.activeWindowAvgWeightedTokens ?? 0, w.allTimeAvgWeightedTokens ?? 0, 1);

  const xOf = (idx: number) =>
    calls.length === 1 ? Math.round(padL + plotW / 2) : Math.round(padL + (idx / (calls.length - 1)) * plotW);
  const yOf = (val: number) => Math.round(bottomY - (val / maxVal) * plotH);

  // Y-axis gridlines (0%, 25%, 50%, 75%, 100%)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const val = Math.round(maxVal * frac);
    const y = yOf(val);
    return svg(
      "g",
      {},
      svg("line", { class: "traj-grid", x1: padL, y1: y, x2: width - padR, y2: y }),
      svg("text", { class: "traj-axis-label", x: padL - 8, y: y + 3, "text-anchor": "end" }, f.compactTokens(val)),
    );
  });

  // X-axis step ticks (directly step numbers, up to 10 evenly spaced ticks)
  const tickCount = Math.min(calls.length, 10);
  const tickIndices =
    calls.length <= tickCount
      ? calls.map((_, i) => i)
      : Array.from({ length: tickCount }, (_, k) => Math.round((k / (tickCount - 1)) * (calls.length - 1)));
  const uniqueTickIndices = [...new Set(tickIndices)];
  const xTicks = uniqueTickIndices.map((idx) => {
    const r = calls[idx];
    if (r === undefined) return null;
    const x = xOf(idx);
    const stepNo = stepNumbers.get(r.call.id) ?? idx + 1;
    const anchor = idx === 0 ? "start" : idx === calls.length - 1 ? "end" : "middle";
    return svg(
      "g",
      {},
      svg("line", { class: "traj-grid", x1: x, y1: bottomY, x2: x, y2: bottomY + 5 }),
      svg("text", { class: "traj-axis-label", x, y: bottomY + 18, "text-anchor": anchor }, `#${stepNo}`),
    );
  });

  // Find compaction indices
  let lastCompactIdx = -1;
  const compactMarkers = calls.flatMap((r, i) => {
    if (r.call.kind !== "compaction") return [];
    lastCompactIdx = i;
    const x = xOf(i);
    const stepNo = stepNumbers.get(r.call.id) ?? i + 1;
    return [
      svg(
        "g",
        {},
        svg("line", { class: "traj-compact-line", x1: x, y1: padT, x2: x, y2: bottomY, "stroke-dasharray": "4 3" }),
        svg("text", { class: "traj-compact-label", x: x + 4, y: padT + 10 }, `#${stepNo} compact`),
      ),
    ];
  });

  // Active window shaded background band (if compactions occurred)
  const activeStartX = lastCompactIdx >= 0 ? xOf(lastCompactIdx) : padL;
  const activeWindowBand =
    lastCompactIdx >= 0
      ? svg("rect", {
          class: "traj-active-band",
          x: activeStartX,
          y: padT,
          width: Math.max(0, width - padR - activeStartX),
          height: plotH,
        })
      : null;

  // All-time average line (when different from active window avg)
  const allTimeAvg = w.allTimeAvgWeightedTokens;
  const activeAvg = w.activeWindowAvgWeightedTokens;
  const allTimeAvgGroup =
    allTimeAvg !== null && allTimeAvg > 0 && lastCompactIdx >= 0
      ? svg(
          "g",
          {},
          svg("line", {
            class: "traj-alltime-line",
            x1: padL,
            y1: yOf(allTimeAvg),
            x2: width - padR,
            y2: yOf(allTimeAvg),
            "stroke-dasharray": "2 4",
          }),
          svg(
            "text",
            { class: "traj-ref-label muted-label", x: padL + 6, y: Math.max(padT + 10, yOf(allTimeAvg) - 4) },
            `All-time avg: ${f.compactTokens(allTimeAvg)}/step`,
          ),
        )
      : null;

  // Active window average line
  const activeAvgGroup =
    activeAvg !== null && activeAvg > 0
      ? svg(
          "g",
          {},
          svg("line", {
            class: "traj-active-avg-line",
            x1: activeStartX,
            y1: yOf(activeAvg),
            x2: width - padR,
            y2: yOf(activeAvg),
            "stroke-dasharray": "5 3",
          }),
          svg(
            "text",
            { class: "traj-ref-label", x: width - padR - 4, y: Math.max(padT + 10, yOf(activeAvg) - 5), "text-anchor": "end" },
            `Active window avg: ${f.compactTokens(activeAvg)}/step`,
          ),
        )
      : null;

  const pts = calls.map((r, i) => `${xOf(i)},${yOf(r.weightedTokens ?? 0)}`).join(" ");
  const areaPts = calls.length > 1 ? `${xOf(0)},${bottomY} ${pts} ${xOf(calls.length - 1)},${bottomY}` : null;

  // Crosshair & active highlight ring
  const lastIdx = calls.length - 1;
  const initX = xOf(lastIdx);
  const initY = yOf(calls[lastIdx]?.weightedTokens ?? 0);
  const crosshair = svg("line", { class: "traj-crosshair", x1: initX, y1: padT, x2: initX, y2: bottomY, "stroke-dasharray": "2 2" });
  const highlightRing = svg("circle", { class: "traj-ring", cx: initX, cy: initY, r: 6 });

  const inspectorHost = h("div", { class: "traj-inspector" });
  let pinnedIdx: number | null = null;

  const scrollToStepRow = (stepNo: number) => {
    const cell = document.querySelector(`[data-step-row="${stepNo}"]`);
    const tr = cell?.closest("tr");
    if (tr instanceof HTMLElement) {
      tr.scrollIntoView({ behavior: "smooth", block: "center" });
      tr.classList.add("flash-row");
      window.setTimeout(() => tr.classList.remove("flash-row"), 1600);
    }
  };

  const updateInspector = (idx: number) => {
    const r = calls[idx];
    if (r === undefined) return;
    const stepNo = stepNumbers.get(r.call.id) ?? idx + 1;
    const x = xOf(idx);
    const y = yOf(r.weightedTokens ?? 0);
    crosshair.setAttribute("x1", String(x));
    crosshair.setAttribute("x2", String(x));
    highlightRing.setAttribute("cx", String(x));
    highlightRing.setAttribute("cy", String(y));

    const ctx = contextOf(r);
    const delta = deltas.get(r.call.id) ?? null;
    const deltaStr = delta === null || delta === 0 ? "" : ` (${delta > 0 ? "+" : "−"}${f.compactTokens(Math.abs(delta))})`;

    const cRead = r.call.cacheRead ?? 0;
    const cWrite = r.call.cacheWrite ?? 0;
    const cNew = r.call.inputUncached ?? 0;
    const cOut = r.call.output ?? 0;
    const wRead = Math.round(cRead * weights.cacheRead);
    const wWrite = Math.round(cWrite * weights.cacheWrite);
    const wNew = Math.round(cNew * weights.inputUncached);
    const wOut = Math.round(cOut * weights.output);

    let vsAvgText = "";
    if (r.weightedTokens !== null && activeAvg !== null && activeAvg > 0) {
      const pct = Math.round(((r.weightedTokens - activeAvg) / activeAvg) * 100);
      vsAvgText = pct === 0 ? " (matches active avg)" : pct > 0 ? ` (+${pct}% vs. active avg)` : ` (−${Math.abs(pct)}% vs. active avg)`;
    }

    const jumpBtn = h("button", { type: "button", class: "col-toggle reset" }, `Jump to step #${stepNo} in table ↓`);
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      scrollToStepRow(stepNo);
    });

    const unpinBtn =
      pinnedIdx !== null
        ? (() => {
            const btn = h("button", { type: "button", class: "col-toggle" }, "Pinned · click to unpin");
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              pinnedIdx = null;
              updateInspector(idx);
            });
            return btn;
          })()
        : h("span", { class: "muted small" }, "Hover chart to inspect · click a step to pin & jump");

    inspectorHost.replaceChildren(
      h(
        "div",
        { class: "traj-inspector-top" },
        h(
          "div",
          {},
          h("strong", {}, `Step #${stepNo}`),
          ` · ${f.time(r.call.timestamp, data.timeZone)} · `,
          r.call.kind === "compaction"
            ? h("span", { class: "badge warn" }, "compaction")
            : r.cache?.cacheLoss
              ? h("span", { class: "badge bad" }, `cache lost (${f.compactTokens(r.cache.reReadTokens)} paid again)`)
              : h("span", { class: "badge good" }, "cache kept"),
          " · Weighted load: ",
          h("strong", {}, `${f.compactTokens(r.weightedTokens)} units`),
          h("span", { class: "muted small" }, vsAvgText),
        ),
        h("div", { class: "traj-inspector-actions" }, unpinBtn, jumpBtn),
      ),
      r.call.kind === "compaction"
        ? h("div", { class: "muted small" }, "Context compacted on this step — active window step count and average reset after this point.")
        : h(
            "div",
            { class: "traj-inspector-grid muted small" },
            h("span", {}, `Context: ${f.tokensShort(ctx)}${deltaStr}`),
            h("span", {}, `From cache: ${f.tokensShort(r.call.cacheRead)} (×${weights.cacheRead} = ${f.compactTokens(wRead)})`),
            h("span", {}, `New input: ${f.tokensShort(r.call.inputUncached)} (×${weights.inputUncached} = ${f.compactTokens(wNew)})`),
            h("span", {}, `Cache write: ${f.tokensShort(r.call.cacheWrite)} (×${weights.cacheWrite} = ${f.compactTokens(wWrite)})`),
            h("span", {}, `Output: ${f.tokensShort(r.call.output)} (×${weights.output} = ${f.compactTokens(wOut)})`),
            h("span", {}, `Tools: ${r.call.toolNames.length === 0 ? "reply only" : r.call.toolNames.join(", ")}`),
          ),
    );
  };

  const dots = calls.map((r, i) => {
    const cx = xOf(i);
    const cy = yOf(r.weightedTokens ?? 0);
    const cls =
      r.call.kind === "compaction"
        ? "traj-dot warn"
        : r.cache?.cacheLoss
          ? "traj-dot bad"
          : "traj-dot";
    const radius = r.call.kind === "compaction" || r.cache?.cacheLoss ? 4 : calls.length > 80 ? 2 : 3;
    return svg("circle", { class: cls, cx, cy, r: radius });
  });

  // Invisible full-height hit strips so hovering anywhere along X snaps to the nearest step
  const hitStrips = calls.map((r, i) => {
    const cx = xOf(i);
    const prevX = i === 0 ? padL : Math.round((xOf(i - 1) + cx) / 2);
    const nextX = i === calls.length - 1 ? width - padR : Math.round((cx + xOf(i + 1)) / 2);
    const stripW = Math.max(4, nextX - prevX);
    const stepNo = stepNumbers.get(r.call.id) ?? i + 1;
    const rect = svg(
      "rect",
      { class: "traj-hit", x: prevX, y: padT, width: stripW, height: plotH },
      svg("title", {}, `Step #${stepNo}: ${f.compactTokens(r.weightedTokens)} weighted units`),
    );
    rect.addEventListener("mouseenter", () => {
      if (pinnedIdx === null) updateInspector(i);
    });
    rect.addEventListener("click", (e) => {
      e.stopPropagation();
      pinnedIdx = pinnedIdx === i ? null : i;
      updateInspector(i);
      scrollToStepRow(stepNo);
    });
    return rect;
  });

  updateInspector(lastIdx);

  const closeBtn = h("button", { type: "button", class: "col-toggle" }, "Close ✕");
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClose();
  });

  return h(
    "div",
    { class: "card trajectory-panel" },
    h(
      "div",
      { class: "trajectory-head" },
      h(
        "div",
        {},
        h("strong", {}, `Step load trajectory (${calls.length} steps)`),
        h(
          "span",
          { class: "muted small" },
          " — weighted cost per step across the session, showing compactions and cache losses",
        ),
      ),
      h(
        "div",
        { class: "trajectory-legend small muted" },
        h("span", { class: "mini-legend-item" }, h("span", { class: "mini-swatch seg-sub" }), "Normal step"),
        h("span", { class: "mini-legend-item" }, h("span", { class: "mini-swatch bad-swatch" }), "Cache loss"),
        h("span", { class: "mini-legend-item" }, h("span", { class: "mini-swatch seg-write" }), "Compaction"),
        closeBtn,
      ),
    ),
    svg(
      "svg",
      { class: "trajectory-svg", viewBox: `0 0 ${width} ${height}`, role: "img" },
      activeWindowBand,
      yTicks,
      xTicks,
      allTimeAvgGroup,
      areaPts === null ? null : svg("polygon", { class: "mini-area", points: areaPts }),
      calls.length > 1 ? svg("polyline", { class: "traj-line", points: pts }) : null,
      compactMarkers,
      activeAvgGroup,
      crosshair,
      dots,
      highlightRing,
      hitStrips,
    ),
    inspectorHost,
  );
}

/** Card 3 mini chart: horizontal stacked bar showing where the total weighted load went (From cache, New input, Cache write, Output, Subagents). */
function renderWeightedBreakdownMini(
  calls: readonly Row[],
  weights: SessionData["weighted"]["weights"],
  subagentWeighted: number,
): HTMLElement | null {
  let cacheWeighted = 0;
  let newWeighted = 0;
  let writeWeighted = 0;
  let outWeighted = 0;
  for (const r of calls) {
    if (r.call.kind !== "turn") continue;
    cacheWeighted += (r.call.cacheRead ?? 0) * weights.cacheRead;
    newWeighted += (r.call.inputUncached ?? 0) * weights.inputUncached;
    writeWeighted += (r.call.cacheWrite ?? 0) * weights.cacheWrite;
    outWeighted += (r.call.output ?? 0) * weights.output;
  }

  const segments = [
    { label: "Cache", value: Math.round(cacheWeighted), cls: "seg-cache" },
    { label: "New", value: Math.round(newWeighted), cls: "seg-new" },
    { label: "Write", value: Math.round(writeWeighted), cls: "seg-write" },
    { label: "Out", value: Math.round(outWeighted), cls: "seg-out" },
    { label: "Sub", value: Math.round(subagentWeighted), cls: "seg-sub" },
  ].filter((s) => s.value > 0);

  const total = segments.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) return null;

  const width = 220;
  const height = 10;
  let cursor = 0;
  const rects = segments.map((s, idx) => {
    const pct = Math.round((s.value / total) * 100);
    const wPx = idx === segments.length - 1 ? Math.max(2, width - cursor) : Math.max(2, Math.round((s.value / total) * width));
    const x = cursor;
    cursor = Math.min(width, cursor + wPx);
    return svg(
      "rect",
      { class: `mini-seg ${s.cls}`, x, y: 0, width: Math.max(1, wPx - (idx < segments.length - 1 ? 1 : 0)), height, rx: 2 },
      svg("title", {}, `${s.label}: ${f.compactTokens(s.value)} weighted units (${pct}%)`),
    );
  });

  const legend = segments
    .filter((s) => Math.round((s.value / total) * 100) >= 4)
    .map((s) =>
      h(
        "span",
        { class: "mini-legend-item" },
        h("span", { class: `mini-swatch ${s.cls}` }),
        `${s.label} ${Math.round((s.value / total) * 100)}%`,
      ),
    );

  return h(
    "div",
    { class: "mini-viz" },
    svg("svg", { class: "mini-stack-svg", viewBox: `0 0 ${width} ${height}`, role: "img" }, rects),
    h("div", { class: "mini-legend" }, legend),
  );
}

/** Card 4 mini chart: horizontal two-bar comparison (Main vs. Subagents per step, or Actual input load vs. Without cache). */
function renderEfficiencyMini(calls: readonly Row[], w: SessionData["weighted"], cacheSavedUnits: number): HTMLElement | null {
  const width = 220;
  const height = 28;
  const barMaxW = 128;
  const barX = 46;

  let row1: { readonly label: string; readonly val: number; readonly cls: string; readonly tip: string };
  let row2: { readonly label: string; readonly val: number; readonly cls: string; readonly tip: string };

  if (w.subagentCount > 0) {
    const mainAvg = w.activeWindowAvgWeightedTokens ?? w.allTimeAvgWeightedTokens ?? 0;
    const subAvg = w.subagentAvgWeightedTokens ?? 0;
    row1 = {
      label: "Main",
      val: mainAvg,
      cls: "mini-hbar main",
      tip: `Main session active avg: ${f.compactTokens(mainAvg)} / step`,
    };
    row2 = {
      label: "Sub",
      val: subAvg,
      cls: "mini-hbar good",
      tip: `Subagent avg: ${f.compactTokens(subAvg)} / step (${w.subagentTurns} steps across ${w.subagentCount} subagents)`,
    };
  } else {
    let actualInputUnits = 0;
    const weights = w.weights;
    for (const r of calls) {
      if (r.call.kind !== "turn") continue;
      actualInputUnits +=
        (r.call.cacheRead ?? 0) * weights.cacheRead +
        (r.call.inputUncached ?? 0) * weights.inputUncached +
        (r.call.cacheWrite ?? 0) * weights.cacheWrite;
    }
    const actualRounded = Math.round(actualInputUnits);
    const uncachedRounded = actualRounded + cacheSavedUnits;
    if (uncachedRounded <= 0) return null;
    row1 = {
      label: "Paid",
      val: actualRounded,
      cls: "mini-hbar good",
      tip: `Actual weighted input load (with cache discount): ${f.compactTokens(actualRounded)} units`,
    };
    row2 = {
      label: "No cache",
      val: uncachedRounded,
      cls: "mini-hbar muted-bar",
      tip: `Input load without cache (at 1× rate): ${f.compactTokens(uncachedRounded)} units`,
    };
  }

  const maxVal = Math.max(row1.val, row2.val, 1);
  const w1 = row1.val > 0 ? Math.max(4, Math.round((row1.val / maxVal) * barMaxW)) : 2;
  const w2 = row2.val > 0 ? Math.max(4, Math.round((row2.val / maxVal) * barMaxW)) : 2;

  return h(
    "div",
    { class: "mini-viz" },
    svg(
      "svg",
      { class: "mini-svg", viewBox: `0 0 ${width} ${height}`, role: "img" },
      svg("text", { class: "mini-svg-label", x: 0, y: 10 }, row1.label),
      svg("rect", { class: row1.cls, x: barX, y: 2, width: w1, height: 9, rx: 2 }, svg("title", {}, row1.tip)),
      svg("text", { class: "mini-svg-val", x: barX + w1 + 5, y: 10 }, f.compactTokens(row1.val)),
      svg("text", { class: "mini-svg-label", x: 0, y: 24 }, row2.label),
      svg("rect", { class: row2.cls, x: barX, y: 16, width: w2, height: 9, rx: 2 }, svg("title", {}, row2.tip)),
      svg("text", { class: "mini-svg-val", x: barX + w2 + 5, y: 24 }, f.compactTokens(row2.val)),
    ),
  );
}

/** Sessions whose subagent table the user expanded; the dashboard redraws on every poll, so the state lives here (R-32). */
const expandedSubagentTables = new Set<string>();

/** ADR 0016: the session's subagents as a table, newest first, `ui.subagentRowsShown` rows until "Show more". */
function subagentTable(data: SessionData): HTMLElement {
  const ids = data.children;
  const initial = data.configuration.ui.subagentRowsShown;
  const container = h("div", { class: "subagents" });
  const key = data.session.id;
  const render = () => {
    const expanded = expandedSubagentTables.has(key);
    const shown = expanded ? ids : ids.slice(0, initial);
    container.replaceChildren(
      h("p", { class: "small" }, `Subagents spawned by this session (${ids.length}), newest first:`),
      table(
        [
          { title: "Subagent", cell: (id: string) => sessionLink(id, data.titles[id] ?? f.shortSessionId(id, true)) },
          {
            title: "Last call",
            cell: (id: string) => {
              const at = data.subagentLastCallAt[id];
              return at === null || at === undefined ? "–" : f.time(at, data.timeZone);
            },
          },
          { title: "Steps", numeric: true, cell: (id: string) => String(data.subagentSummaries[id]?.totalTurns ?? "–") },
          {
            title: "Units",
            numeric: true,
            cell: (id: string) => {
              const sub = data.subagentSummaries[id];
              return sub === undefined ? "–" : f.compactTokens(sub.sessionWeightedTokens);
            },
          },
          {
            title: "Units / step",
            numeric: true,
            cell: (id: string) => {
              const avg = data.subagentSummaries[id]?.allTimeAvgWeightedTokens;
              return avg === null || avg === undefined ? "–" : f.compactTokens(avg);
            },
          },
        ],
        shown,
      ),
      ...(ids.length > initial
        ? [(() => {
            const btn = h("button", { type: "button", class: "small" }, expanded ? "Show fewer" : `Show ${ids.length - initial} more`);
            btn.addEventListener("click", () => {
              if (expanded) expandedSubagentTables.delete(key);
              else expandedSubagentTables.add(key);
              render();
            });
            return btn;
          })()]
        : []),
    );
  };
  render();
  return container;
}
