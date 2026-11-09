// Pins how the standalone host finds and reads configuration files (ADR 0007, R-24).
// Uses a temporary directory only; never touches harness log directories (R-15).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  defaultConfigPath,
  expandHome,
  loadConfigFromFiles,
  resolveLogRoots,
  resolveUserConfigPath,
} from "../../../src/hosts/node/config.js";

const HOME = "/home/user";
const CWD = "/work";

describe("resolveUserConfigPath", () => {
  it("uses --config <path> first, relative to the working directory", () => {
    const path = resolveUserConfigPath({ argv: ["--config", "my.json"], env: { XDG_CONFIG_HOME: "/xdg" }, homeDir: HOME, cwd: CWD });
    assert.equal(path, "/work/my.json");
  });

  it("accepts --config=<path> and expands ~", () => {
    const path = resolveUserConfigPath({ argv: ["--config=~/c.json"], env: {}, homeDir: HOME, cwd: CWD });
    assert.equal(path, "/home/user/c.json");
  });

  it("falls back to $XDG_CONFIG_HOME", () => {
    const path = resolveUserConfigPath({ argv: [], env: { XDG_CONFIG_HOME: "/xdg" }, homeDir: HOME, cwd: CWD });
    assert.equal(path, "/xdg/agent-token-monitor/config.json");
  });

  it("ignores an empty or relative $XDG_CONFIG_HOME and uses ~/.config", () => {
    for (const xdg of ["", "relative/dir"]) {
      const path = resolveUserConfigPath({ argv: [], env: { XDG_CONFIG_HOME: xdg }, homeDir: HOME, cwd: CWD });
      assert.equal(path, "/home/user/.config/agent-token-monitor/config.json");
    }
  });
});

describe("expandHome", () => {
  it("expands only a leading ~", () => {
    assert.equal(expandHome("~", HOME), HOME);
    assert.equal(expandHome("~/.claude/projects", HOME), "/home/user/.claude/projects");
    assert.equal(expandHome("/abs/~/x", HOME), "/abs/~/x");
    assert.equal(expandHome("~other/x", HOME), "~other/x");
  });
});

describe("loadConfigFromFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "atm-config-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the shipped defaults when no user file exists", async () => {
    const result = await loadConfigFromFiles(defaultConfigPath(), join(dir, "missing.json"));
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("applies a user file and expands ~ in log roots", async () => {
    const userPath = join(dir, "config.json");
    writeFileSync(userPath, JSON.stringify({ logRoots: { codex: ["~/codex-logs"] } }));
    const result = await loadConfigFromFiles(defaultConfigPath(), userPath);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(resolveLogRoots(result.config, HOME).codex, ["/home/user/codex-logs"]);
  });

  it("names the user file in errors", async () => {
    const userPath = join(dir, "bad.json");
    writeFileSync(userPath, JSON.stringify({ ui: { pollInterval: 1 } }));
    const result = await loadConfigFromFiles(defaultConfigPath(), userPath);
    assert.deepEqual(result, { ok: false, errors: [{ file: userPath, path: "ui.pollInterval", message: "unknown key" }] });
  });
});
