// Pins the standalone server of ADR 0013: 127.0.0.1 only, GET only, Host check, static files, the data API.
// Reads only the anonymized fixtures; the user configuration lives in a temporary directory (R-15).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { defaultConfigPath } from "../../../src/hosts/node/config.js";
import { portArgument } from "../../../src/hosts/node/main.js";
import { startServer } from "../../../src/hosts/node/server.js";
import { AnalysisStore } from "../../../src/hosts/node/store.js";

const FIXTURES = fileURLToPath(new URL("../../../../test/fixtures", import.meta.url));
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function get(port: number, path: string, options: { host?: string; method?: string } = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { Host: options.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function serve(userConfig: unknown): Promise<{ server: Server; port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "atm-server-"));
  const userConfigPath = join(dir, "config.json");
  writeFileSync(userConfigPath, typeof userConfig === "string" ? userConfig : JSON.stringify(userConfig));
  const store = new AnalysisStore({ defaultsPath: defaultConfigPath(), userConfigPath, homeDir: dir, systemTimeZone: "UTC" });
  const server = await startServer(
    {
      store,
      staticDir: fileURLToPath(new URL("../../../../web/static", import.meta.url)),
      scriptDir: fileURLToPath(new URL("../../../web/src", import.meta.url)),
      vendorDir: fileURLToPath(new URL("../../../../web/vendor", import.meta.url)),
      now: () => NOW,
    },
    0,
  );
  return { server, port: (server.address() as AddressInfo).port, dir };
}

describe("standalone server", () => {
  let ctx: { server: Server; port: number; dir: string };

  before(async () => {
    ctx = await serve({
      logRoots: {
        claudeCode: [join(FIXTURES, "claude-code", "projects")],
        antigravity: [join(FIXTURES, "antigravity", "brain")],
        codex: [],
      },
    });
  });

  after(() => {
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("listens on 127.0.0.1 only", () => {
    assert.equal((ctx.server.address() as AddressInfo).address, "127.0.0.1");
  });

  it("refuses any other Host header, so a rebound domain cannot reach the API", async () => {
    assert.equal((await get(ctx.port, "/api/overview", { host: `evil.example:${ctx.port}` })).status, 403);
    assert.equal((await get(ctx.port, "/api/overview", { host: `localhost:${ctx.port}` })).status, 200);
  });

  it("serves GET only", async () => {
    assert.equal((await get(ctx.port, "/api/overview", { method: "POST" })).status, 405);
  });

  it("serves the page and its scripts, and nothing outside them", async () => {
    const page = await get(ctx.port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<script type="module" src="js\/main.js">/);
    assert.equal((await get(ctx.port, "/js/main.js")).status, 200);
    assert.equal((await get(ctx.port, "/vendor/uplot/uPlot.iife.min.js")).status, 200);
    assert.equal((await get(ctx.port, "/vendor/uplot/LICENSE")).status, 404);
    assert.equal((await get(ctx.port, "/vendor/../package.json")).status, 404);
    assert.equal((await get(ctx.port, "/js/../../package.json")).status, 404);
    assert.equal((await get(ctx.port, "/%2e%2e/package.json")).status, 404);
  });

  it("answers the data API with the envelope of every response", async () => {
    const overview = JSON.parse((await get(ctx.port, "/api/overview")).body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(overview), [
      "asOf",
      "configuration",
      "diagnostics",
      "openSessions",
      "sessionAdvice",
      "sessionLoads",
      "sessionTree",
      "thisMonth",
      "timeZone",
      "today",
    ]);
    assert.equal(overview["asOf"], NOW);
    assert.equal(overview["timeZone"], "UTC");
    for (const endpoint of ["usage?by=month", "cache", "diagnostics"]) {
      assert.equal((await get(ctx.port, `/api/${endpoint}`)).status, 200, endpoint);
    }
    assert.equal((await get(ctx.port, "/api/usage?by=year")).status, 400);
    assert.equal((await get(ctx.port, "/api/nothing")).status, 404);
  });

  it("returns one session's calls, and 404 for an unknown session", async () => {
    const usage = JSON.parse((await get(ctx.port, "/api/usage?by=session")).body) as { periods: { period: string }[] };
    const id = usage.periods[0]?.period as string;
    const one = JSON.parse((await get(ctx.port, `/api/sessions/${encodeURIComponent(id)}`)).body) as { session: { id: string }; calls: unknown[] };
    assert.equal(one.session.id, id);
    assert.ok(one.calls.length > 0);
    assert.equal((await get(ctx.port, "/api/sessions/none")).status, 404);
  });
});

describe("configuration errors", () => {
  it("replace every response with the errors and no results (ADR 0007)", async () => {
    const ctx = await serve({ cache: { hitTolerance: 5 } });
    try {
      const body = JSON.parse((await get(ctx.port, "/api/overview")).body) as { configErrors: { path: string }[] };
      assert.deepEqual(body.configErrors.map((e) => e.path), ["cache.hitTolerance"]);
    } finally {
      ctx.server.close();
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

describe("--port", () => {
  it("defaults to 0 (a free port) and rejects anything but a port number", () => {
    assert.equal(portArgument([]), 0);
    assert.equal(portArgument(["--port", "8080"]), 8080);
    assert.equal(portArgument(["--port=9"]), 9);
    assert.equal(portArgument(["--port", "x"]), null);
    assert.equal(portArgument(["--port", "70000"]), null);
  });
});
