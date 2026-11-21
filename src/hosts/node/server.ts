// Standalone host: HTTP server on 127.0.0.1 that serves the dashboard files and the data API (ADR 0002, 0005, 0013).
// GET only; requests for any other Host are refused, so a web page cannot reach the API by DNS rebinding (R-14).

import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";

import * as api from "../../core/api/index.js";
import { buildHtmlReport, buildReportData, REPORT_FILENAME, type ReportAssets } from "../../core/api/report.js";
import { stableStringify } from "../../core/config/config.js";
import type { AnalysisStore } from "./store.js";

export interface ServerOptions {
  readonly store: AnalysisStore;
  /** web/static: index.html and stylesheets. */
  readonly staticDir: string;
  /** dist/web/src: compiled frontend modules. */
  readonly scriptDir: string;
  /** web/vendor: pinned uPlot and Bootstrap assets (ADR 0005, ADR 0019). */
  readonly vendorDir: string;
  /** Host clock in epoch milliseconds; the only clock read of the product (ADR 0006). */
  readonly now: () => number;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Relative paths of static files and scripts: no "..", no hidden files; inner dots allowed (uPlot.iife.min.js). */
const SAFE_PATH = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:html|css|js)$/;

export function startServer(options: ServerOptions, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    handle(request, response, options, (server.address() as AddressInfo).port).catch((error: unknown) => {
      send(response, 500, "text/plain; charset=utf-8", `internal error: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ServerOptions, port: number): Promise<void> {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(response, 403, "text/plain; charset=utf-8", "forbidden host");
  if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "method not allowed");

  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname.startsWith("/api/")) return answerApi(url, response, options);
  if (url.pathname === "/") return sendFile(response, join(options.staticDir, "index.html"));
  if (url.pathname.startsWith("/js/")) {
    const path = url.pathname.slice("/js/".length);
    if (SAFE_PATH.test(path)) return sendFile(response, join(options.scriptDir, ...path.split("/")));
  } else if (url.pathname.startsWith("/vendor/")) {
    const path = url.pathname.slice("/vendor/".length);
    if (SAFE_PATH.test(path)) return sendFile(response, join(options.vendorDir, ...path.split("/")));
  } else {
    const path = url.pathname.slice(1);
    if (SAFE_PATH.test(path)) return sendFile(response, join(options.staticDir, ...path.split("/")));
  }
  send(response, 404, "text/plain; charset=utf-8", "not found");
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Shared `/api/*` router used by both the HTTP server and the VS Code Webview host (ADR 0013, ADR 0021). */
export async function dispatchApi(endpoint: string, store: AnalysisStore, nowFn: () => number): Promise<ApiResponse> {
  const url = new URL(endpoint, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) return { status: 404, body: { error: "unknown endpoint" } };
  const now = nowFn();
  const state = await store.current(now);
  if (!state.ok) return { status: 200, body: api.configErrorResponse(state.errors) };
  const analysis = state.analysis;
  const route = url.pathname.slice("/api/".length);

  if (route === "overview") return { status: 200, body: api.overview(analysis, now) };
  if (route === "usage") {
    const by = url.searchParams.get("by") ?? "day";
    if (by !== "day" && by !== "month" && by !== "session") {
      return { status: 400, body: { error: "by must be day, month or session" } };
    }
    return { status: 200, body: api.usage(analysis, now, by) };
  }
  if (route === "cache") {
    const daysParam = url.searchParams.get("days");
    if (daysParam === null || daysParam === "" || daysParam === "all") {
      return { status: 200, body: api.cache(analysis, now) };
    }
    const days = Number(daysParam);
    if (!Number.isSafeInteger(days) || days < 1) {
      return { status: 400, body: { error: "days must be all or a positive integer" } };
    }
    return { status: 200, body: api.cache(analysis, now, days) };
  }
  if (route === "diagnostics") return { status: 200, body: api.diagnostics(analysis, now) };
  if (route.startsWith("sessions/")) {
    const result = api.session(analysis, now, decodeURIComponent(route.slice("sessions/".length)));
    return result === null ? { status: 404, body: { error: "unknown session" } } : { status: 200, body: result };
  }
  return { status: 404, body: { error: "unknown endpoint" } };
}

async function answerApi(url: URL, response: ServerResponse, options: ServerOptions): Promise<void> {
  if (url.pathname === "/api/report") {
    const now = options.now();
    const state = await options.store.current(now);
    if (!state.ok) return sendJson(response, 200, api.configErrorResponse(state.errors));
    return sendReport(response, state.analysis, now, options);
  }
  const { status, body } = await dispatchApi(url.pathname + url.search, options.store, options.now);
  sendJson(response, status, body);
}

async function sendFile(response: ServerResponse, path: string): Promise<void> {
  const type = CONTENT_TYPES[extname(path)];
  let body: Buffer;
  try {
    body = await readFile(path);
  } catch {
    return send(response, 404, "text/plain; charset=utf-8", "not found");
  }
  send(response, 200, type ?? "application/octet-stream", body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", stableStringify(value));
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, extraHeaders: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extraHeaders });
  response.end(body);
}

async function sendReport(response: ServerResponse, analysis: api.Analysis, now: number, options: ServerOptions): Promise<void> {
  const assets = await readReportAssets(options);
  const html = buildHtmlReport(buildReportData(analysis, now), assets);
  send(response, 200, CONTENT_TYPES[".html"] as string, html, {
    "Content-Disposition": `attachment; filename="${REPORT_FILENAME}"`,
  });
}

async function readReportAssets(options: ServerOptions): Promise<ReportAssets> {
  const [indexHtml, bootstrapCss, uplotCss, appCss, uplotJs] = await Promise.all([
    readFile(join(options.staticDir, "index.html"), "utf8"),
    readFile(join(options.vendorDir, "bootstrap", "bootstrap.min.css"), "utf8"),
    readFile(join(options.vendorDir, "uplot", "uPlot.min.css"), "utf8"),
    readFile(join(options.staticDir, "style.css"), "utf8"),
    readFile(join(options.vendorDir, "uplot", "uPlot.iife.min.js"), "utf8"),
  ]);
  const modules: Record<string, string> = {};
  await collectJsModules(join(options.vendorDir, "bootstrap", "js"), "vendor/bootstrap/js", modules);
  await collectJsModules(options.scriptDir, "js", modules);
  return {
    indexHtml,
    stylesheets: [bootstrapCss, uplotCss, appCss],
    classicScripts: [uplotJs],
    modules,
    entryModules: ["vendor/bootstrap/js/drawer.js", "js/main.js"],
  };
}

async function collectJsModules(dir: string, prefix: string, out: Record<string, string>): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectJsModules(full, key, out);
    } else if (entry.name.endsWith(".js")) {
      out[key] = await readFile(full, "utf8");
    }
  }
}
