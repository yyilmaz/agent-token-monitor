// VS Code extension entry point (R-25, R-26, ADR 0021).
// No top-level await so VS Code's Node.js 22+ runtime can load this ESM entry via require(esm).

import * as vscode from "vscode";

import { DashboardController } from "./panel.js";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new DashboardController({
    vscode,
    extensionUri: context.extensionUri,
  });
  context.subscriptions.push(controller);
}

export function deactivate(): void {
  // All subscriptions are disposed by VS Code via context.subscriptions.
}
