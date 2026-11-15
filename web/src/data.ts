// The single data-access layer (ADR 0005, ADR 0021, ADR 0023). In the browser it uses fetch; in an exported HTML
// report it reads embedded JSON from #report-data; in a VS Code Webview it uses postMessage with the same endpoints.

import type { ReportData } from "../../src/core/api/report.js";
import type { ConfigError } from "../../src/core/config/config.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

export class ConfigErrors extends Error {
  constructor(readonly errors: readonly ConfigError[]) {
    super("configuration errors");
  }
}

let cachedReport: ReportData | null | undefined;

function embeddedReport(): ReportData | null {
  if (cachedReport !== undefined) return cachedReport;
  if (typeof document === "undefined") {
    cachedReport = null;
    return null;
  }
  const element = document.getElementById("report-data");
  if (element === null || !element.textContent) {
    cachedReport = null;
    return null;
  }
  cachedReport = JSON.parse(element.textContent) as ReportData;
  return cachedReport;
}

export function isOfflineReport(): boolean {
  return embeddedReport() !== null;
}

interface PendingRequest {
  readonly resolve: (value: { status: number; body: unknown }) => void;
  readonly reject: (reason: unknown) => void;
}

const vsCodeApi: VsCodeApi | null = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const pending = new Map<number, PendingRequest>();
const refreshListeners: (() => void)[] = [];
let nextRequestId = 1;

if (vsCodeApi !== null && typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; id?: unknown; status?: unknown; body?: unknown } | null;
    if (data === null || typeof data !== "object") return;
    if (data.type === "refresh") {
      for (const listener of refreshListeners) listener();
      return;
    }
    if (data.type !== "apiResponse" || typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (entry === undefined) return;
    pending.delete(data.id);
    entry.resolve({ status: typeof data.status === "number" ? data.status : 500, body: data.body });
  });
}

export function onHostRefresh(listener: () => void): void {
  refreshListeners.push(listener);
}

export async function getJson<T>(endpoint: string): Promise<T> {
  const report = embeddedReport();
  if (report !== null) {
    if (endpoint === "/api/overview") return report.overview as T;
    if (endpoint === "/api/usage?by=day") return report.usageByDay as T;
    if (endpoint === "/api/cache") return report.cache as T;
    if (endpoint === "/api/diagnostics") return report.diagnostics as T;
    if (endpoint.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(endpoint.slice("/api/sessions/".length));
      const detail = report.sessions[id];
      if (detail === undefined) throw new Error("unknown session");
      return detail as T;
    }
    throw new Error(`unknown endpoint: ${endpoint}`);
  }
  let status: number;
  let body: unknown;
  if (vsCodeApi !== null) {
    const id = nextRequestId++;
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      vsCodeApi.postMessage({ type: "apiRequest", id, endpoint });
    });
    status = response.status;
    body = response.body;
  } else {
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    status = response.status;
    body = await response.json();
  }
  const payload = body as T & { configErrors?: readonly ConfigError[]; error?: string };
  if (payload.configErrors !== undefined) throw new ConfigErrors(payload.configErrors);
  if (status < 200 || status >= 300) throw new Error(payload.error ?? `request failed: ${status}`);
  return payload;
}
