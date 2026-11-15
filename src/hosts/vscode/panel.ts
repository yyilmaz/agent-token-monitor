// VS Code host: manages the dashboard Webview panel, postMessage API bridge, and config reload (R-25, R-26, ADR 0021).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultConfigPath } from "../node/config.js";
import { dispatchApi } from "../node/server.js";
import { AnalysisStore } from "../node/store.js";
import { resolveVsCodeConfigPath } from "./config-path.js";
import { buildWebviewHtml } from "./webview-html.js";

export interface Disposable {
  dispose(): void;
}

export interface WebviewLike<TUri extends UriLike = UriLike> {
  readonly cspSource: string;
  html: string;
  asWebviewUri(localResource: TUri): { toString(): string };
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
}

export interface WebviewPanelLike<TUri extends UriLike = UriLike> extends Disposable {
  readonly webview: WebviewLike<TUri>;
  reveal(viewColumn?: number): void;
  onDidDispose(listener: () => unknown): Disposable;
}

export interface UriLike {
  readonly fsPath: string;
}

export interface VscodeHost<TUri extends UriLike = UriLike> {
  readonly ViewColumn: { readonly One: number };
  readonly Uri: {
    joinPath(base: TUri, ...pathSegments: readonly string[]): TUri;
  };
  readonly window: {
    createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: number,
      options: { readonly enableScripts: boolean; readonly retainContextWhenHidden: boolean; readonly localResourceRoots: readonly TUri[] },
    ): WebviewPanelLike<TUri>;
  };
  readonly workspace: {
    readonly workspaceFolders?: readonly { readonly uri: TUri }[] | undefined;
    getConfiguration(section?: string): { get<T>(section: string, defaultValue: T): T };
    onDidChangeConfiguration(listener: (event: { affectsConfiguration(section: string): boolean }) => unknown): Disposable;
  };
  readonly commands: {
    registerCommand(command: string, callback: () => unknown): Disposable;
  };
}

export interface ControllerOptions<TUri extends UriLike = UriLike> {
  readonly vscode: VscodeHost<TUri>;
  readonly extensionUri: TUri;
  readonly now?: () => number;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly systemTimeZone?: string;
  readonly defaultsPath?: string;
  readonly indexHtml?: string;
  readonly createStore?: (userConfigPath: string) => AnalysisStore;
}

export const COMMAND_OPEN_DASHBOARD = "agentTokenMonitor.openDashboard";
export const CONFIG_SECTION = "agentTokenMonitor";
export const CONFIG_PATH_KEY = "configPath";

export class DashboardController<TUri extends UriLike = UriLike> implements Disposable {
  private readonly vscode: VscodeHost<TUri>;
  private readonly extensionUri: TUri;
  private readonly now: () => number;
  private readonly homeDir: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly platform: NodeJS.Platform;
  private readonly systemTimeZone: string;
  private readonly defaultsPath: string;
  private readonly indexHtml: string;
  private readonly createStore: (userConfigPath: string) => AnalysisStore;
  private readonly disposables: Disposable[] = [];

  private store: AnalysisStore;
  private panel: WebviewPanelLike<TUri> | null = null;
  private panelDisposables: Disposable[] = [];

  constructor(options: ControllerOptions<TUri>) {
    this.vscode = options.vscode;
    this.extensionUri = options.extensionUri;
    this.now = options.now ?? (() => Date.now());
    this.homeDir = options.homeDir ?? homedir();
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.systemTimeZone = options.systemTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.defaultsPath = options.defaultsPath ?? defaultConfigPath();
    this.indexHtml =
      options.indexHtml ?? readFileSync(join(this.extensionUri.fsPath, "web", "static", "index.html"), "utf8");
    this.createStore =
      options.createStore ??
      ((userConfigPath) =>
        new AnalysisStore({
          defaultsPath: this.defaultsPath,
          userConfigPath,
          homeDir: this.homeDir,
          systemTimeZone: this.systemTimeZone,
          platform: this.platform,
          env: this.env,
        }));

    this.store = this.createStore(this.resolveConfigPath());

    this.disposables.push(
      this.vscode.commands.registerCommand(COMMAND_OPEN_DASHBOARD, () => this.openDashboard()),
      this.vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_PATH_KEY}`)) return;
        this.store = this.createStore(this.resolveConfigPath());
        void this.panel?.webview.postMessage({ type: "refresh" });
      }),
    );
  }

  resolveConfigPath(): string {
    const configuredPath = this.vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_PATH_KEY, "");
    const workspaceDirs = (this.vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return resolveVsCodeConfigPath({
      configuredPath,
      workspaceDirs,
      env: this.env,
      homeDir: this.homeDir,
    });
  }

  openDashboard(): WebviewPanelLike<TUri> {
    if (this.panel !== null) {
      this.panel.reveal(this.vscode.ViewColumn.One);
      return this.panel;
    }

    const staticRoot = this.vscode.Uri.joinPath(this.extensionUri, "web", "static");
    const vendorRoot = this.vscode.Uri.joinPath(this.extensionUri, "web", "vendor");
    const scriptRoot = this.vscode.Uri.joinPath(this.extensionUri, "dist", "web", "src");

    const panel = this.vscode.window.createWebviewPanel(
      "agentTokenMonitor.dashboard",
      "Agent Token Monitor",
      this.vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [staticRoot, vendorRoot, scriptRoot],
      },
    );

    const resolveAssetUri = (relativePath: string): string => {
      const segments = relativePath.split("/").filter((s) => s.length > 0);
      let resource: TUri;
      if (segments[0] === "vendor") {
        resource = this.vscode.Uri.joinPath(vendorRoot, ...segments.slice(1));
      } else if (segments[0] === "js") {
        resource = this.vscode.Uri.joinPath(scriptRoot, ...segments.slice(1));
      } else {
        resource = this.vscode.Uri.joinPath(staticRoot, ...segments);
      }
      return panel.webview.asWebviewUri(resource).toString();
    };

    panel.webview.html = buildWebviewHtml({
      indexHtml: this.indexHtml,
      cspSource: panel.webview.cspSource,
      toUri: resolveAssetUri,
    });

    const onMessage = panel.webview.onDidReceiveMessage((raw) => {
      void this.handleMessage(panel, raw);
    });
    const onDispose = panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
        for (const d of this.panelDisposables) d.dispose();
        this.panelDisposables = [];
      }
    });

    this.panel = panel;
    this.panelDisposables = [onMessage, onDispose];
    return panel;
  }

  private async handleMessage(panel: WebviewPanelLike<TUri>, raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== "object") return;
    const message = raw as { type?: unknown; id?: unknown; endpoint?: unknown };
    if (message.type !== "apiRequest" || typeof message.id !== "number" || typeof message.endpoint !== "string") return;

    let response: { readonly status: number; readonly body: unknown };
    try {
      response = await dispatchApi(message.endpoint, this.store, this.now);
    } catch (error: unknown) {
      response = {
        status: 500,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    if (this.panel !== panel) return;
    await panel.webview.postMessage({
      type: "apiResponse",
      id: message.id,
      status: response.status,
      body: response.body,
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.panelDisposables) d.dispose();
    this.panelDisposables = [];
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
