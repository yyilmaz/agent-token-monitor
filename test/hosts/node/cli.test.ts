// Exercise the compiled standalone entry point (ADR 0013) with an isolated home (R-15).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("../../../src/hosts/node/main.js", import.meta.url));

function runStatus(context: TestContext, config: string) {
  const homeDir = mkdtempSync(join(tmpdir(), "atm-cli-"));
  context.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const configPath = join(homeDir, "config.json");
  writeFileSync(configPath, config);

  const result = spawnSync(process.execPath, [entryPoint, "--status", "--config", configPath], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

it("--status prints an overview and exits without starting the server (ADR 0013)", (context) => {
  const result = runStatus(context, "{}");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const overview = JSON.parse(result.stdout);
  assert.equal(typeof overview.asOf, "number");
  assert.deepEqual(overview.openSessions, []);
});

it("--status reports invalid configuration on stderr with exit code 2 (ADR 0007, ADR 0013)", (context) => {
  const result = runStatus(context, "{");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, "invalidConfiguration");
  assert.ok(failure.errors.length > 0);
});

it("--help prints usage and exits with code 0", () => {
  const result = spawnSync(process.execPath, [entryPoint, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: agent-token-monitor/);
  assert.match(result.stdout, /--port/);
  assert.match(result.stdout, /--status/);
});

it("runs via a symlinked bin from an arbitrary cwd outside the repository", async (context) => {
  const tempDir = mkdtempSync(join(tmpdir(), "atm-bin-"));
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const binLink = join(tempDir, "agent-token-monitor");
  chmodSync(entryPoint, 0o755);
  symlinkSync(entryPoint, binLink);

  const statusResult = spawnSync(binLink, ["--status"], {
    cwd: tempDir,
    env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir, XDG_CONFIG_HOME: join(tempDir, "xdg") },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(statusResult.error);
  assert.equal(statusResult.status, 0);
  assert.equal(statusResult.stderr, "");
  const overview = JSON.parse(statusResult.stdout);
  assert.equal(typeof overview.asOf, "number");

  const child = spawn(binLink, ["--port", "0"], {
    cwd: tempDir,
    env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir, XDG_CONFIG_HOME: join(tempDir, "xdg") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });

  const url = await new Promise<URL>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for server URL; stdout=${stdout} stderr=${stderr}`)), 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolve(new URL(match[0]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}; stderr=${stderr}`));
    });
  });

  const fetchStatus = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(url.port), path }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });

  assert.equal(await fetchStatus("/"), 200);
  assert.equal(await fetchStatus("/js/main.js"), 200);
  assert.equal(await fetchStatus("/vendor/uplot/uPlot.iife.min.js"), 200);
  assert.equal(await fetchStatus("/api/overview"), 200);
});
