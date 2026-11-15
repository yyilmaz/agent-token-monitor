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
  expandRootPath,
  loadConfigFromFiles,
  resolveLogRoots,
  resolveSessionIndexRoots,
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

describe("expandRootPath", () => {
  it("expands leading $VAR and %VAR% when set, and returns null when unset or empty", () => {
    const env = { XDG_CONFIG_HOME: "/xdg", APPDATA: "/win/AppData/Roaming", EMPTY: "" };
    assert.equal(expandRootPath("$XDG_CONFIG_HOME/Claude/sessions", HOME, env), "/xdg/Claude/sessions");
    assert.equal(expandRootPath("%APPDATA%/Claude/sessions", HOME, env), "/win/AppData/Roaming/Claude/sessions");
    assert.equal(expandRootPath("$MISSING_VAR/Claude", HOME, env), null);
    assert.equal(expandRootPath("%MISSING_VAR%/Claude", HOME, env), null);
    assert.equal(expandRootPath("$EMPTY/Claude", HOME, env), null);
    assert.equal(expandRootPath("~/.claude/projects", HOME, env), "/home/user/.claude/projects");
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

  it("resolves platform-appropriate defaults for darwin, linux, and win32 (R-24)", async () => {
    const missing = join(dir, "missing.json");

    const darwin = await loadConfigFromFiles(defaultConfigPath(), missing, "darwin");
    assert.ok(darwin.ok);
    assert.deepEqual(resolveLogRoots(darwin.config, "/Users/alice", {}), {
      claudeCode: ["/Users/alice/.claude/projects"],
      antigravity: ["/Users/alice/.gemini/antigravity/brain"],
      codex: ["/Users/alice/.codex/sessions"],
      opencode: ["/Users/alice/.local/share/opencode"],
    });
    assert.deepEqual(resolveSessionIndexRoots(darwin.config, "/Users/alice", {}), {
      claudeCode: ["/Users/alice/Library/Application Support/Claude/claude-code-sessions"],
      antigravity: ["/Users/alice/.gemini/antigravity/annotations"],
      codex: [],
      opencode: [],
    });

    const linux = await loadConfigFromFiles(defaultConfigPath(), missing, "linux");
    assert.ok(linux.ok);
    assert.deepEqual(resolveLogRoots(linux.config, HOME, {}), {
      claudeCode: ["/home/user/.claude/projects"],
      antigravity: ["/home/user/.gemini/antigravity/brain"],
      codex: ["/home/user/.codex/sessions"],
      opencode: ["/home/user/.local/share/opencode"],
    });
    assert.deepEqual(resolveSessionIndexRoots(linux.config, HOME, {}), {
      claudeCode: ["/home/user/.config/Claude/claude-code-sessions"],
      antigravity: ["/home/user/.gemini/antigravity/annotations"],
      codex: [],
      opencode: [],
    });
    assert.deepEqual(
      resolveSessionIndexRoots(linux.config, HOME, { XDG_CONFIG_HOME: "/custom/xdg" }).claudeCode,
      ["/custom/xdg/Claude/claude-code-sessions", "/home/user/.config/Claude/claude-code-sessions"],
    );
    assert.deepEqual(
      resolveSessionIndexRoots(linux.config, HOME, { XDG_CONFIG_HOME: "/home/user/.config" }).claudeCode,
      ["/home/user/.config/Claude/claude-code-sessions"],
    );

    const win32 = await loadConfigFromFiles(defaultConfigPath(), missing, "win32");
    assert.ok(win32.ok);
    const winHome = "/win/Users/alice";
    const winEnv = { APPDATA: "/win/Users/alice/AppData/Roaming", LOCALAPPDATA: "/win/Users/alice/AppData/Local" };
    assert.deepEqual(resolveLogRoots(win32.config, winHome, winEnv), {
      claudeCode: ["/win/Users/alice/.claude/projects"],
      antigravity: ["/win/Users/alice/.gemini/antigravity/brain"],
      codex: ["/win/Users/alice/.codex/sessions"],
      opencode: ["/win/Users/alice/AppData/Local/opencode", "/win/Users/alice/.local/share/opencode"],
    });
    assert.deepEqual(resolveSessionIndexRoots(win32.config, winHome, winEnv), {
      claudeCode: ["/win/Users/alice/AppData/Roaming/Claude/claude-code-sessions"],
      antigravity: ["/win/Users/alice/.gemini/antigravity/annotations"],
      codex: [],
      opencode: [],
    });
    assert.deepEqual(resolveSessionIndexRoots(win32.config, winHome, {}).claudeCode, [
      "/win/Users/alice/AppData/Roaming/Claude/claude-code-sessions",
    ]);
  });

  it("lets user overrides take precedence over platform defaults", async () => {
    const userPath = join(dir, "win-override.json");
    writeFileSync(userPath, JSON.stringify({ sessionIndexRoots: { claudeCode: ["/custom/win-sessions"] } }));
    const result = await loadConfigFromFiles(defaultConfigPath(), userPath, "win32");
    assert.ok(result.ok);
    assert.deepEqual(resolveSessionIndexRoots(result.config, HOME, { APPDATA: "/win/AppData" }).claudeCode, ["/custom/win-sessions"]);
    assert.deepEqual(resolveLogRoots(result.config, HOME, { LOCALAPPDATA: "/win/Local" }).opencode, [
      "/win/Local/opencode",
      "/home/user/.local/share/opencode",
    ]);
  });
});
