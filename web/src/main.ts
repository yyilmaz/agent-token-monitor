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
  readonly configuration: { readonly ui: { readonly pollIntervalSeconds: number } };
}

const state: { usage: UsageState } = { usage: { by: "day", split: "total", range: 0, where: "harness", metric: "tokens", chart: "harness" } };
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
      // The summary always needs days; the Details table may ask for months or sessions as well.
      const days = await getJson<ReturnType<typeof api.usage>>("/api/usage?by=day");
      const detail = state.usage.by === "day" ? days : await getJson<ReturnType<typeof api.usage>>(`/api/usage?by=${state.usage.by}`);
      show(renderUsage(days, detail, state.usage, (next) => {
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
  view().replaceChildren(element);
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
    status.textContent = `Updated ${new Date(data.asOf).toLocaleTimeString()}`;
    status.classList.remove("error");
  } catch (error) {
    if (mine !== generation) return;
    if (error instanceof ConfigErrors) {
      view().replaceChildren(
        h("h2", { class: "error" }, "The configuration has errors. No results are shown until they are fixed."),
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
  const nav = document.getElementById("tabs") as HTMLElement;
  nav.replaceChildren(...TABS.map(([hash, label]) => h("a", hash === tab ? { href: `#${hash}`, "aria-current": "page" } : { href: `#${hash}` }, label)));
}

window.addEventListener("hashchange", () => {
  renderTabs();
  view().replaceChildren(h("p", { class: "muted" }, "Loading…"));
  window.scrollTo(0, 0);
  void refresh();
});

renderTabs();
void refresh();
