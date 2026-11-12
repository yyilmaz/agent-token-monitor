// View 1, "Now": open sessions (R-33, ADR 0013).

import type { SessionAdvice } from "../../../src/core/analysis/advice.js";
import type { DiagnosticGroup } from "../../../src/core/analysis/diagnostics.js";
import type { OpenSession, TreeRow } from "../../../src/core/analysis/live.js";
import type { diagnostics, overview } from "../../../src/core/api/index.js";
import { adviceBadge, adviceDetailsNodes, adviceTag } from "../advice.js";
import { h, sessionLink, svg, table } from "../dom.js";
import * as f from "../format.js";

type Overview = ReturnType<typeof overview>;

export interface NowState {
  readonly harness: string;
  readonly project: string;
}

const HARNESS_ORDER = ["claudeCode", "antigravity", "codex", "opencode"];

const STATUS: Readonly<Record<OpenSession["cacheStatus"], [string, string]>> = {
  warm: ["warm", "good"],
  probablyCold: ["probably cold", "warn"],
  missedOnLastCall: ["missed on last call", "bad"],
};

type SessionLoad = Overview["sessionLoads"][string];

let openAdviceSessionId: string | null = null;

function sessionDisplayName(r: TreeRow): string {
  const isSubagent = r.relation === "subagent";
  return r.title ?? (r.project !== null ? f.project(r.project) : f.shortSessionId(r.sessionId, isSubagent));
}

function ensureAdviceDrawer(): {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  badgeSlot: HTMLElement;
  body: HTMLElement;
} {
  const existing = document.getElementById("advice-drawer");
  if (existing instanceof HTMLDialogElement) {
    return {
      dialog: existing,
      title: existing.querySelector<HTMLElement>("#advice-drawer-title")!,
      badgeSlot: existing.querySelector<HTMLElement>(".advice-drawer-badge")!,
      body: existing.querySelector<HTMLElement>(".drawer-body")!,
    };
  }
  const title = h("h3", { id: "advice-drawer-title", class: "m-0 fs-6 fw-semibold" }, "Advice");
  const badgeSlot = h("span", { class: "advice-drawer-badge" });
  const closeBtn = h(
    "button",
    { type: "button", class: "btn-icon", "aria-label": "Close advice details" },
    svg("svg", { width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.5 },
      svg("path", { d: "m5 5 10 10M15 5 5 15" })),
  );
  const body = h("div", { class: "drawer-body" });
  const dialog = h(
    "dialog",
    {
      id: "advice-drawer",
      class: "drawer drawer-end advice-drawer",
      closedby: "any",
      "aria-labelledby": "advice-drawer-title",
    },
    h(
      "div",
      { class: "drawer-header d-flex align-items-start justify-content-between gap-3" },
      h("div", { class: "d-flex flex-column gap-1 min-w-0" }, title, badgeSlot),
      closeBtn,
    ),
    body,
  );
  closeBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    openAdviceSessionId = null;
  });
  // Fallback for browsers without <dialog closedby="any"> support (e.g., Safari).
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = rect.top <= event.clientY && event.clientY <= rect.top + rect.height && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  }
  document.body.append(dialog);
  return { dialog, title, badgeSlot, body };
}

function populateAdviceDrawer(advice: SessionAdvice, row: TreeRow | undefined): void {
  const { dialog, title, badgeSlot, body } = ensureAdviceDrawer();
  title.textContent = row === undefined ? f.shortSessionId(advice.sessionId, false) : sessionDisplayName(row);
  const badge = adviceBadge(advice);
  badgeSlot.replaceChildren(...(badge === null ? [] : [badge]));
  body.replaceChildren(...adviceDetailsNodes(advice, () => dialog.close()));
}

export function renderNow(data: Overview, state: NowState, onChange: (next: NowState) => void): HTMLElement {
  const adviceById = new Map(data.sessionAdvice.map((a) => [a.sessionId, a]));
  const rowById = new Map(data.sessionTree.map((r) => [r.sessionId, r]));
  const rows = filterTree(data.sessionTree, state);
  const filters = nowFilters(data.sessionTree, state, onChange);

  if (openAdviceSessionId !== null) {
    const existingDialog = document.getElementById("advice-drawer");
    if (existingDialog instanceof HTMLDialogElement && existingDialog.open) {
      const currentAdvice = adviceById.get(openAdviceSessionId);
      if (currentAdvice !== undefined) populateAdviceDrawer(currentAdvice, rowById.get(openAdviceSessionId));
      else existingDialog.close();
    }
  }

  const openAdviceDrawer = (advice: SessionAdvice) => {
    openAdviceSessionId = advice.sessionId;
    populateAdviceDrawer(advice, rowById.get(advice.sessionId));
    const { dialog } = ensureAdviceDrawer();
    if (!dialog.open) dialog.showModal();
  };

  return h(
    "div",
    {},
    h("div", { class: "d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3" }, h("h2", { class: "m-0" }, "Open sessions"), filters),
    table(
      [
        { title: "Session", cell: (r: TreeRow) => sessionCell(r, adviceById.get(r.sessionId)) },
        {
          title: "Context",
          help: "Current context size and recent 5-step weighted average load per step (and active window average since last compaction).",
          numeric: true,
          cell: (r) => contextCell(r, adviceById.get(r.sessionId), data.sessionLoads[r.sessionId]),
        },
        {
          title: "Total weighted",
          help: "Total weighted load of the session (including child subagents for top-level sessions) so you can compare token load across tasks.",
          numeric: true,
          defaultHidden: true,
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
        { title: "Cache", cell: (r) => cacheCell(r) },
        // ADR 0017: keep going, compact now or start fresh; detailed breakdown opens in the drawer.
        { title: "Advice", cell: (r) => adviceTag(adviceById.get(r.sessionId), openAdviceDrawer) },
      ],
      rows,
      state.harness || state.project
        ? "No open sessions match the current filters."
        : `No session had a call in the last ${f.duration(data.configuration.liveView.openWithinSeconds)}.`,
      undefined,
      "open-sessions",
    ),
  );
}

function nowFilters(tree: readonly TreeRow[], state: NowState, onChange: (next: NowState) => void): HTMLElement | null {
  if (tree.length === 0) return null;
  const harnesses = HARNESS_ORDER.filter((id) => tree.some((r) => r.harness === id));
  const projects = [...new Set(tree.map((r) => f.repository(r.project)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const harnessSelect = selectControl(
    "Filter by harness",
    [["", "All harnesses"], ...harnesses.map((id): [string, string] => [id, f.harness(id)])],
    state.harness,
    (v) => onChange({ ...state, harness: v }),
  );
  const projectSelect = selectControl(
    "Filter by project",
    [["", "All projects"], ...projects.map((p): [string, string] => [p, p])],
    state.project,
    (v) => onChange({ ...state, project: v }),
  );
  const clear =
    state.harness === "" && state.project === ""
      ? null
      : (() => {
          const btn = h("button", { type: "button", class: "btn btn-sm col-toggle reset" }, "Clear");
          btn.addEventListener("click", () => onChange({ harness: "", project: "" }));
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

function filterTree(tree: readonly TreeRow[], state: NowState): TreeRow[] {
  if (state.harness === "" && state.project === "") return [...tree];
  const keep = new Set<number>();
  for (let i = 0; i < tree.length; i++) {
    const r = tree[i] as TreeRow;
    const matchesHarness = state.harness === "" || r.harness === state.harness;
    const matchesProject = state.project === "" || f.repository(r.project) === state.project;
    if (!matchesHarness || !matchesProject) continue;
    keep.add(i);
    let targetDepth = r.depth - 1;
    for (let j = i - 1; j >= 0 && targetDepth >= 0; j--) {
      const prev = tree[j] as TreeRow;
      if (prev.depth === targetDepth) {
        keep.add(j);
        targetDepth--;
      }
    }
  }
  return tree.filter((_, i) => keep.has(i));
}

/** The title, else the project folder or short session ID, with harness and model metadata underneath (TREE-1, ADR 0016). */
function sessionCell(r: TreeRow, adv: SessionAdvice | undefined): HTMLElement {
  const isSubagent = r.relation === "subagent";
  const hasName = r.title !== null || r.project !== null;
  const name = sessionDisplayName(r);
  const modelText =
    r.open !== null
      ? f.model(r.open.model, r.open.modelSource)
      : adv !== undefined && adv.model !== null
        ? f.model(adv.model, adv.modelSource)
        : "";
  const metaParts = [
    r.title !== null && r.project !== null ? f.project(r.project) : "",
    f.harness(r.harness),
    modelText,
  ].filter((part) => part !== "");

  return h(
    "div",
    { class: "tree session-cell", "data-depth": String(Math.min(r.depth, 6)) },
    h(
      "div",
      { class: "session-title-line" },
      r.depth > 0 ? h("span", { class: "muted" }, "↳ ") : null,
      sessionLink(r.sessionId, name),
      r.relation === "root" || (!hasName && isSubagent)
        ? null
        : h("span", { class: "muted small" }, isSubagent ? " · subagent" : " · side session"),
    ),
    metaParts.length === 0 ? null : h("div", { class: "muted small session-meta" }, metaParts.join(" · ")),
  );
}

function contextCell(r: TreeRow, adv: SessionAdvice | undefined, load: SessionLoad | undefined): HTMLElement {
  const ctx = r.open !== null ? r.open.contextTokens : (adv?.contextTokens ?? null);
  const stepLoad =
    load !== undefined && load.recentAvgWeightedTokens !== null
      ? h(
          "div",
          { class: "mt-1" },
          h(
            "span",
            {
              class: "badge step-load-value",
              title: `Recent avg: ${f.tokens(load.recentAvgWeightedTokens)} / step · Active window avg: ${f.tokens(load.activeWindowAvgWeightedTokens)} / step (${load.activeTurns} steps)`,
            },
            `${f.compactTokens(load.recentAvgWeightedTokens)}/step`,
          ),
        )
      : null;

  return h(
    "div",
    { class: "context-cell" },
    ctx === null ? h("span", { class: "muted" }, "—") : h("span", { title: `${f.tokens(ctx)} tokens` }, f.compactTokens(ctx)),
    stepLoad,
  );
}

function cacheCell(r: TreeRow): HTMLElement {
  if (r.open === null) {
    return h("span", { class: "badge", title: "TREE-1 · no call of its own within the open window; a session under it is active" }, "waiting");
  }
  const s = r.open;
  const [text, tone] = STATUS[s.cacheStatus];
  return h(
    "div",
    { class: "cache-cell" },
    h("span", { class: `badge ${tone}`, title: `LIVE-1 · reference lifetime ${f.duration(s.referenceLifetimeSeconds)} (${s.referenceSource})` }, text),
    h("div", { class: "muted small mt-1", title: "Time since last call" }, `${f.duration(s.secondsSinceLastCall)} ago`),
  );
}

/** R-23: problems grouped by kind, most serious and most frequent first, with what each does to the figures. */
export function renderDiagnostics(data: ReturnType<typeof diagnostics>): HTMLElement {
  const { errors, warnings, files } = data.summary;
  const summary =
    errors + warnings === 0
      ? null
      : h(
          "p",
          { class: "muted" },
          `${errors} ${f.plural(errors, "error")}, ${warnings} ${f.plural(warnings, "warning")} in ${files} ${f.plural(files, "log file")}.`,
        );
  return h(
    "div",
    {},
    summary,
    table(
      [
        {
          title: "Problem",
          cell: (g: DiagnosticGroup) =>
            h(
              "div",
              { class: "wrap" },
              h("span", { class: `badge ${g.severity === "error" ? "bad" : "warn"} me-2` }, g.severity),
              h("span", { class: "fw-semibold" }, g.title),
              g.effect === null ? null : h("div", { class: "muted small" }, g.effect),
              h("div", { class: "muted small" }, g.message, " ", h("code", {}, g.code)),
            ),
        },
        { title: "Harness", cell: (g) => f.harness(g.harness) },
        { title: "Count", numeric: true, cell: (g) => String(g.count) },
        { title: "Files", numeric: true, cell: (g) => String(g.files) },
        {
          title: "Where",
          cell: (g) =>
            h(
              "details",
              {},
              h("summary", {}, `${g.locations.length} of ${g.count}`),
              g.locations.map((s) => h("div", { class: "small" }, `${s.file}:${s.line}`)),
            ),
        },
      ],
      data.groups,
      "Every log line was read.",
    ),
  );
}
