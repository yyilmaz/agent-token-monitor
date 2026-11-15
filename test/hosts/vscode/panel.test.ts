import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  COMMAND_OPEN_DASHBOARD,
  DashboardController,
  type Disposable,
  type UriLike,
  type VscodeHost,
  type WebviewPanelLike,
} from "../../../src/hosts/vscode/panel.js";

interface MockUri extends UriLike {
  readonly fsPath: string;
}

function createMockVscode(options: { configuredPath?: string; workspaceDirs?: readonly string[] } = {}) {
  let configuredPath = options.configuredPath ?? "";
  const commands = new Map<string, () => unknown>();
  const configListeners: ((e: { affectsConfiguration(section: string): boolean }) => unknown)[] = [];
  const createdPanels: {
    readonly panel: WebviewPanelLike<MockUri>;
    readonly posted: unknown[];
    readonly options: { readonly enableScripts: boolean; readonly retainContextWhenHidden: boolean; readonly localResourceRoots: readonly MockUri[] };
    revealCount: number;
    disposed: boolean;
    emitMessage: (msg: unknown) => void;
    emitDispose: () => void;
  }[] = [];

  const vscode: VscodeHost<MockUri> = {
    ViewColumn: { One: 1 },
    Uri: {
      joinPath: (base, ...segments) => ({ fsPath: join(base.fsPath, ...segments) }),
    },
    window: {
      createWebviewPanel: (_viewType, _title, _showOptions, panelOptions) => {
        const posted: unknown[] = [];
        const messageListeners: ((msg: unknown) => unknown)[] = [];
        const disposeListeners: (() => unknown)[] = [];
        const record = {
          panel: null as unknown as WebviewPanelLike<MockUri>,
          posted,
          options: panelOptions,
          revealCount: 0,
          disposed: false,
          emitMessage: (msg: unknown) => {
            for (const listener of messageListeners) listener(msg);
          },
          emitDispose: () => {
            record.disposed = true;
            for (const listener of disposeListeners) listener();
          },
        };
        const panel: WebviewPanelLike<MockUri> = {
          webview: {
            cspSource: "https://mock.vscode-resource",
            html: "",
            asWebviewUri: (uri) => ({ toString: () => `https://mock.vscode-resource${uri.fsPath}` }),
            postMessage: async (msg) => {
              posted.push(msg);
              return true;
            },
            onDidReceiveMessage: (listener): Disposable => {
              messageListeners.push(listener);
              return { dispose: () => {} };
            },
          },
          reveal: () => {
            record.revealCount++;
          },
          onDidDispose: (listener): Disposable => {
            disposeListeners.push(listener);
            return { dispose: () => {} };
          },
          dispose: () => {
            if (!record.disposed) record.emitDispose();
          },
        };
        record.panel = panel;
        createdPanels.push(record);
        return panel;
      },
    },
    workspace: {
      workspaceFolders: options.workspaceDirs?.map((dir) => ({ uri: { fsPath: dir } })),
      getConfiguration: () => ({
        get: <T>(_key: string, defaultValue: T) => (configuredPath as unknown as T) ?? defaultValue,
      }),
      onDidChangeConfiguration: (listener): Disposable => {
        configListeners.push(listener);
        return { dispose: () => {} };
      },
    },
    commands: {
      registerCommand: (command, callback): Disposable => {
        commands.set(command, callback);
        return { dispose: () => commands.delete(command) };
      },
    },
  };

  return {
    vscode,
    commands,
    createdPanels,
    setConfiguredPath: (next: string) => {
      configuredPath = next;
      for (const listener of configListeners) {
        listener({ affectsConfiguration: (section) => section === "agentTokenMonitor.configPath" });
      }
    },
  };
}

describe("DashboardController (R-25, R-26, ADR 0021)", () => {
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

  it("opens one Webview panel with restricted localResourceRoots, reveals it on repeat, and routes API messages", async () => {
    const temp = mkdtempSync(join(tmpdir(), "atm-vscode-test-"));
    try {
      const configPath = join(temp, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          schemaVersion: 3,
          logRoots: { claudeCode: [], antigravity: [], codex: [], opencode: [] },
          sessionIndexRoots: { claudeCode: [], antigravity: [], codex: [], opencode: [] },
        }),
      );

      const mock = createMockVscode({ configuredPath: configPath });
      const controller = new DashboardController({
        vscode: mock.vscode,
        extensionUri: { fsPath: repoRoot },
        now: () => 1_700_000_000_000,
      });

      const open = mock.commands.get(COMMAND_OPEN_DASHBOARD);
      assert.ok(open, "command should be registered");
      open();
      assert.equal(mock.createdPanels.length, 1);

      const first = mock.createdPanels[0]!;
      assert.equal(first.options.enableScripts, true);
      assert.deepEqual(
        first.options.localResourceRoots.map((u) => u.fsPath),
        [join(repoRoot, "web", "static"), join(repoRoot, "web", "vendor"), join(repoRoot, "dist", "web", "src")],
      );
      assert.match(first.panel.webview.html, /Content-Security-Policy/);

      // Second invocation reveals existing panel instead of creating another.
      open();
      assert.equal(mock.createdPanels.length, 1);
      assert.equal(first.revealCount, 1);

      // API request via postMessage
      first.emitMessage({ type: "apiRequest", id: 1, endpoint: "/api/overview" });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(first.posted.length, 1);
      const overviewMsg = first.posted[0] as { type: string; id: number; status: number; body: { asOf: number } };
      assert.equal(overviewMsg.type, "apiResponse");
      assert.equal(overviewMsg.id, 1);
      assert.equal(overviewMsg.status, 200);
      assert.equal(overviewMsg.body.asOf, 1_700_000_000_000);

      // 404 endpoint
      first.emitMessage({ type: "apiRequest", id: 2, endpoint: "/api/sessions/missing" });
      await new Promise((r) => setTimeout(r, 20));
      const notFoundMsg = first.posted[1] as { type: string; id: number; status: number };
      assert.equal(notFoundMsg.status, 404);

      // Changing agentTokenMonitor.configPath triggers a refresh message
      const nextConfigPath = join(temp, "other.json");
      writeFileSync(
        nextConfigPath,
        JSON.stringify({
          schemaVersion: 3,
          logRoots: { claudeCode: [], antigravity: [], codex: [], opencode: [] },
          sessionIndexRoots: { claudeCode: [], antigravity: [], codex: [], opencode: [] },
        }),
      );
      mock.setConfiguredPath(nextConfigPath);
      assert.equal(controller.resolveConfigPath(), nextConfigPath);
      assert.deepEqual(first.posted[2], { type: "refresh" });

      // Disposing panel allows opening a fresh one
      first.emitDispose();
      open();
      assert.equal(mock.createdPanels.length, 2);

      controller.dispose();
      assert.equal(mock.commands.has(COMMAND_OPEN_DASHBOARD), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
