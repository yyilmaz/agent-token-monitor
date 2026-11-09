// Standalone host: HTTP server on 127.0.0.1 that serves the dashboard files and the data API (ADR 0002, 0005, 0013).
// GET only; requests for any other Host are refused, so a web page cannot reach the API by DNS rebinding (R-14).

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";

import * as api from "../../core/api/index.js";
import { stableStringify } from "../../core/config/config.js";
import type { AnalysisStore } from "./store.js";

export interface ServerOptions {
  readonly store: AnalysisStore;
  /** web/static: index.html and stylesheets. */
  readonly staticDir: string;
  /** dist/web/src: compiled frontend modules. */
  readonly scriptDir: string;
  /** web/vendor: pinned third-party files (uPlot, ADR 0005). */
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

async function answerApi(url: URL, response: ServerResponse, options: ServerOptions): Promise<void> {
  const now = options.now();
  const state = await options.store.current(now);
  if (!state.ok) return sendJson(response, 200, api.configErrorResponse(state.errors));
  const analysis = state.analysis;
  const route = url.pathname.slice("/api/".length);

  if (route === "overview") return sendJson(response, 200, api.overview(analysis, now));
  if (route === "usage") {
    const by = url.searchParams.get("by") ?? "day";
    if (by !== "day" && by !== "month" && by !== "session") return sendJson(response, 400, { error: "by must be day, month or session" });
    return sendJson(response, 200, api.usage(analysis, now, by));
  }
  if (route === "cache") return sendJson(response, 200, api.cache(analysis, now));
  if (route === "diagnostics") return sendJson(response, 200, api.diagnostics(analysis, now));
  if (route.startsWith("sessions/")) {
    const result = api.session(analysis, now, decodeURIComponent(route.slice("sessions/".length)));
    return result === null ? sendJson(response, 404, { error: "unknown session" }) : sendJson(response, 200, result);
  }
  sendJson(response, 404, { error: "unknown endpoint" });
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

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  response.end(body);
}
