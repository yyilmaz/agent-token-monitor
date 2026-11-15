import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveVsCodeConfigPath } from "../../../src/hosts/vscode/config-path.js";

describe("resolveVsCodeConfigPath (ADR 0021)", () => {
  const homeDir = "/Users/example";

  it("falls back to $XDG_CONFIG_HOME or ~/.config when configuredPath is empty", () => {
    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: "",
        workspaceDirs: ["/work/project"],
        env: {},
        homeDir,
      }),
      join(homeDir, ".config", "agent-token-monitor", "config.json"),
    );

    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: "   ",
        workspaceDirs: [],
        env: { XDG_CONFIG_HOME: "/custom/xdg" },
        homeDir,
      }),
      join("/custom/xdg", "agent-token-monitor", "config.json"),
    );
  });

  it("expands leading ~ in configuredPath", () => {
    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: "~/atm/my-config.json",
        workspaceDirs: ["/work/project"],
        env: {},
        homeDir,
      }),
      join(homeDir, "atm", "my-config.json"),
    );
  });

  it("resolves relative paths against the first workspace folder or homeDir", () => {
    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: ".vscode/atm.json",
        workspaceDirs: ["/work/project", "/work/other"],
        env: {},
        homeDir,
      }),
      join("/work/project", ".vscode", "atm.json"),
    );

    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: "atm.json",
        workspaceDirs: [],
        env: {},
        homeDir,
      }),
      join(homeDir, "atm.json"),
    );
  });

  it("preserves absolute paths", () => {
    assert.equal(
      resolveVsCodeConfigPath({
        configuredPath: "/etc/atm/config.json",
        workspaceDirs: ["/work/project"],
        env: {},
        homeDir,
      }),
      "/etc/atm/config.json",
    );
  });
});
