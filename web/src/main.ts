// Dashboard entry: tab routing by URL hash and polling of the visible view only (ADR 0005, ADR 0013).

import type * as api from "../../src/core/api/index.js";
import { ConfigErrors, getJson } from "./data.js";
import { h, table } from "./dom.js";
import { sweepCharts } from "./chart.js";
import { renderCache } from "./views/cache.js";
import { renderDiagnostics, renderNow } from "./views/now.js";
import { renderSession } from "./views/session.js";
import { renderUsage, type UsageState } from "./views/usage.js";

const TABS: readonly [hash: string, label: string][] = [
  ["now", "Now"],
  ["usage", "Usage"],
  ["cache", "Cache"],
];

interface Response {
  readonly asOf: number;
  readonly diagnosticCount?: number;
  readonly configuration: { readonly ui: { readonly pollIntervalSeconds: number } };
}

const state: { usage: UsageState } = { usage: { range: 0, where: "harness", chartModes: {} } };
let timer: number | undefined;
let generation = 0;

function view(): HTMLElement {
  return document.getElementById("view") as HTMLElement;
}

function route(): { tab: string; arg: string } {
  const hash = location.hash.slice(1) || "now";
  const slash = hash.indexOf("/");
  return slash === -1 ? { tab: hash, arg: "" } : { tab: hash.slice(0, slash), arg: decodeURIComponent(hash.slice(slash + 1)) };
}

/** Fetches the endpoint of the visible view and renders it. */
async function load(): Promise<Response> {
  const { tab, arg } = route();
  switch (tab) {
    case "usage": {
      const days = await getJson<ReturnType<typeof api.usage>>("/api/usage?by=day");
      show(renderUsage(days, state.usage, (next) => {
        state.usage = next;
        void refresh();
      }));
      return days;
    }
    case "cache": {
      const data = await getJson<ReturnType<typeof api.cache>>("/api/cache");
      show(renderCache(data));
      return data;
    }
    case "diagnostics": {
      const data = await getJson<ReturnType<typeof api.diagnostics>>("/api/diagnostics");
      show(renderDiagnostics(data));
      return data;
    }
    case "session": {
      const data = await getJson<NonNullable<ReturnType<typeof api.session>>>(`/api/sessions/${encodeURIComponent(arg)}`);
      show(renderSession(data));
      return data;
    }
    default: {
      const data = await getJson<ReturnType<typeof api.overview>>("/api/overview");
      show(renderNow(data));
      return data;
    }
  }
}

function show(element: HTMLElement): void {
  // Keep the reader's place across refreshes: the scroll position and which <details> are open.
  const scroll = window.scrollY;
  const open = new Set(detailsKeys(view()).filter(([, d]) => d.open).map(([key]) => key));
  for (const [key, d] of detailsKeys(element)) if (open.has(key)) d.open = true;
  const columns = view().querySelector<HTMLElement>(".column-menu:popover-open");
  const focusId = columns?.parentElement?.contains(document.activeElement) ? document.activeElement?.id : undefined;
  view().replaceChildren(element);
  if (columns !== null) {
    const menu = document.getElementById(columns.id);
    const trigger = document.getElementById(`${columns.id}-toggle`);
    if (menu !== null && trigger !== null) {
      menu.showPopover({ source: trigger });
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    }
  }
  sweepCharts();
  window.scrollTo(0, scroll);
}

/** Each <details> keyed by its summary text and how many came before it with the same text. */
function detailsKeys(root: HTMLElement): [string, HTMLDetailsElement][] {
  const seen = new Map<string, number>();
  return [...root.querySelectorAll("details")].map((d) => {
    const text = d.querySelector("summary")?.textContent ?? "";
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return [`${text}\u0000${n}`, d];
  });
}

async function refresh(): Promise<void> {
  const mine = ++generation;
  window.clearTimeout(timer);
  const status = document.getElementById("status") as HTMLElement;
  let interval = 5;
  try {
    const data = await load();
    if (mine !== generation) return;
    interval = data.configuration.ui.pollIntervalSeconds;
    diagnosticsCount = data.diagnosticCount;
    renderDiagnosticsTab();
    status.textContent = `Updated ${new Date(data.asOf).toLocaleTimeString()}`;
    status.classList.remove("error");
  } catch (error) {
    if (mine !== generation) return;
    if (error instanceof ConfigErrors) {
      view().replaceChildren(
        h("h2", { class: "alert theme-danger error" }, "The configuration has errors. No results are shown until they are fixed."),
        table(
          [
            { title: "File", cell: (e: ConfigErrors["errors"][number]) => e.file },
            { title: "Key", cell: (e) => e.path || "(whole file)" },
            { title: "Problem", cell: (e) => e.message },
          ],
          error.errors,
        ),
      );
    }
    status.textContent = error instanceof ConfigErrors ? "Configuration error" : `Cannot reach the server: ${error instanceof Error ? error.message : String(error)}`;
    status.classList.add("error");
  }
  timer = window.setTimeout(() => void refresh(), interval * 1000);
}

function renderTabs(): void {
  const { tab } = route();
  for (const link of tabs.querySelectorAll("a")) {
    const active = link.hash === `#${tab}`;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  renderDiagnosticsTab();
}

// The visible view's API envelope keeps the navbar count current without an extra poll (R-23, ADR 0013).
let diagnosticsCount: number | undefined;
const diagnosticsBadge = h("span", { class: "badge", hidden: "" });
const diagnosticsTab = h("li", { class: "nav-item" },
  h("a", { class: "nav-link", href: "#diagnostics" }, "Diagnostics", diagnosticsBadge),
);

function renderDiagnosticsTab(): void {
  diagnosticsTab.hidden = diagnosticsCount === 0 && route().tab !== "diagnostics";
  diagnosticsBadge.hidden = !diagnosticsCount;
  diagnosticsBadge.textContent = diagnosticsCount ? String(diagnosticsCount) : "";
}

// Bootstrap 6's mobile drawer manages focus and scroll locking (R-26, ADR 0019).
const tabs = document.getElementById("tabs") as HTMLUListElement;
const drawer = document.getElementById("nav-drawer") as HTMLDialogElement;
const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
tabs.replaceChildren(...TABS.map(([hash, label]) =>
  h("li", { class: "nav-item" }, h("a", { class: "nav-link", href: `#${hash}` }, label)),
), diagnosticsTab);
tabs.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement && drawer.open) drawer.requestClose();
});
drawer.addEventListener("shown.bs.drawer", () => toggle.setAttribute("aria-expanded", "true"));
drawer.addEventListener("hidden.bs.drawer", () => toggle.setAttribute("aria-expanded", "false"));

// Bootstrap color modes share one setting with the dashboard palette (R-26, ADR 0019).
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeKey = "atm.theme";
let theme: "light" | "dark" | null = null;
try {
  const saved = window.localStorage.getItem(themeKey);
  if (saved === "light" || saved === "dark") theme = saved;
} catch {
  // Storage can be restricted by the host.
}

function applyTheme(): void {
  const dark = theme === "dark" || (theme === null && systemTheme.matches);
  document.documentElement.dataset.bsTheme = dark ? "dark" : "light";
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeToggle.title = dark ? "Switch to light theme" : "Switch to dark theme";
}

themeToggle.addEventListener("click", () => {
  theme = document.documentElement.dataset.bsTheme === "dark" ? "light" : "dark";
  applyTheme();
  try {
    window.localStorage.setItem(themeKey, theme);
  } catch {
    // The selected theme still applies for this page.
  }
  if (route().tab === "usage") void refresh();
});
systemTheme.addEventListener("change", () => {
  if (theme !== null) return;
  applyTheme();
  if (route().tab === "usage") void refresh();
});
applyTheme();

window.addEventListener("hashchange", () => {
  renderTabs();
  view().replaceChildren(h("p", { class: "card p-5 muted", role: "status" }, "Loading…"));
  window.scrollTo(0, 0);
  void refresh();
});

renderTabs();
void refresh();
