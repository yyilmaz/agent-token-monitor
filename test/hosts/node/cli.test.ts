// Exercise the compiled standalone entry point (ADR 0013) with an isolated home (R-15).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
