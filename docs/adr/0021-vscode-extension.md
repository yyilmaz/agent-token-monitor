# 0021. Native VS Code extension host and Webview integration

- Status: Accepted
- Date: 2026-11-15
- Requirements: R-14, R-15, R-25, R-26, R-32, R-72

## Context

The core (`src/core/`) is host-independent and boundary-tested, and the standalone Node.js host (`src/hosts/node/`) implements log reading, incremental caching (`AnalysisStore`), configuration loading, and the `/api/*` endpoints. To fulfill R-25 and R-26, we now need a native VS Code extension host under `src/hosts/vscode/` that runs inside the VS Code extension host and renders the existing `web/` dashboard inside a VS Code Webview panel, without network calls (R-14) or writes to harness directories (R-15).

Several concrete technical choices are not yet recorded in ADR 0002, ADR 0005, or ADR 0006:

1. How the extension manifest (`engines.vscode`, `main`, `contributes`) is packaged alongside the standalone CLI.
2. Which development dependencies are added (`@types/vscode`, `@vscode/vsce`, and whether a bundler is needed) and how the `.vsix` package is produced.
3. How the Webview loads `web/` assets under VS Code's Content Security Policy, switches `web/src/data.ts` to `postMessage`, and follows the active VS Code theme (R-26).
4. How `agentTokenMonitor.configPath` is resolved and how `src/hosts/vscode/` is unit-tested under `node --test`.

## Decision

1. **Single root `package.json` manifest (no bundler):**
   - Keep one `package.json` at the repository root serving both the `agent-token-monitor` CLI (`bin`) and the VS Code extension (`main`, `engines.vscode`, `contributes`).
   - Set `"engines": { "vscode": "^1.108.0" }`, matching the minimum runtime verified in ADR 0006 (bundled Node.js 22.21.1 with unflagged `require(esm)`).
   - Point `"main"` to `./dist/src/hosts/vscode/extension.js` (compiled by `tsc` as ESM with no top-level `await`, loaded by VS Code via `require(esm)`). No bundler (`esbuild`) is added.
   - Contribute:
     - Command `agentTokenMonitor.openDashboard` ("Agent Token Monitor: Open Dashboard").
     - Configuration setting `agentTokenMonitor.configPath` (`type: "string"`, `default: ""`), matching [Configuration](../configuration.md).
2. **Development dependencies only:**
   - Add `"@types/vscode": "1.108.0"` (pinned to an exact version, matching `engines.vscode`) to `devDependencies`. Runtime dependencies remain zero (ADR 0004).
   - Add `"vscode"` to `"types"` in `tsconfig.json` (or import `"vscode"` with `@types/vscode` installed).
   - Add `"@vscode/vsce": "4.1.1"` (exact version) to `devDependencies` for `.vsix` packaging only. It is never loaded at runtime.
   - Add `"overrides": { "minimatch": "11.0.8" }` so the transitive `minimatch` of `vsce` is not the version flagged by `npm audit` (GHSA-g3hv-75wg-m249). Remove the override once `vsce` ships a fixed range.
3. **`.vsix` packaging:**
   - `npm run package` runs `vsce package` and writes `agent-token-monitor-<version>.vsix` to the repository root. `*.vsix` is git-ignored.
   - `vsce` runs `vscode:prepublish` (`npm run build`) first, so the package always contains a fresh `dist/`.
   - The package contents are the existing `files` allowlist of `package.json` (`config/default.json`, `dist/src/`, `dist/web/`, `web/static/`, `web/vendor/`) plus the files `vsce` always adds (`package.json`, `README.md`, `LICENSE`). No `.vscodeignore` is used, so the CLI package and the extension package ship the same files.
   - Publishing to the Visual Studio Marketplace or Open VSX is not part of this decision.
4. **Host reuse and configuration resolution:**
   - `src/hosts/vscode/` reuses `AnalysisStore`, `defaultConfigPath`, `expandHome`, and `resolveUserConfigPath` from `src/hosts/node/` (both run on Node.js).
   - When `agentTokenMonitor.configPath` is non-empty, leading `~` is expanded and relative paths are resolved against the first open workspace folder (or `homedir()` if none is open). When empty, `resolveUserConfigPath` falls back to `$XDG_CONFIG_HOME/agent-token-monitor/config.json` or `~/.config/agent-token-monitor/config.json`.
   - Changing `agentTokenMonitor.configPath` via `workspace.onDidChangeConfiguration` updates the store's config path and triggers a refresh of an open Webview panel.
5. **Webview CSP, asset loading, `postMessage` bridge, and theme:**
   - The Webview panel sets `localResourceRoots` to `web/static`, `web/vendor`, and `dist/web/src` only.
   - The extension builds the Webview HTML from `web/static/index.html`, rewriting relative asset URLs (`vendor/...`, `style.css`, `js/main.js`) to `webview.asWebviewUri(...)` and injecting a strict CSP `<meta>` tag:
     `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource};`
   - `web/src/data.ts` detects `acquireVsCodeApi` at runtime (declared via local ambient type, no `vscode` import in `web/`). In a Webview, `getJson(endpoint)` sends `{ type: "apiRequest", id, endpoint }` via `postMessage` and awaits `{ type: "apiResponse", id, status, body }` from the extension host, which routes the same `/api/*` endpoints as `src/hosts/node/server.ts`.
   - `web/src/main.ts` observes `document.body` class changes (`vscode-light`, `vscode-dark`, `vscode-high-contrast`) when running inside a VS Code Webview so `data-bs-theme` tracks the active editor theme (R-26).
6. **Testing:**
   - Unit tests in `test/hosts/vscode/` run with `node --test` against a lightweight mock of the VS Code API (testing config path resolution, `postMessage` API routing, HTML/CSP rewriting, and panel lifecycle without launching Electron).

## Alternatives considered

- **Separate `extensions/vscode/package.json`:** avoids mixing CLI and extension fields in root `package.json`, but duplicates `files`, build scripts, and version management for a single-package repository.
- **Bundling with `esbuild`:** produces a smaller `.vsix` and single-file CommonJS bundle, but adds a new build tool and dependency tree contrary to ADR 0006's "no bundler initially" decision. Can be added later in its own ADR if extension startup time requires it.
- **Starting the localhost HTTP server inside VS Code and loading it in an `<iframe>` or `fetch`:** avoids `postMessage`, but requires opening a local TCP port and loosening Webview `connect-src` CSP, whereas ADR 0002 and ADR 0005 specify `postMessage` for the Webview data channel.

## VS Code compatibility

This ADR directly specifies the native VS Code extension host (`src/hosts/vscode/`), Webview integration, and manifest contributions required by R-25 and R-26. All `src/core/` modules remain untouched and free of Node.js or `vscode` imports, and `web/` remains usable in both the standalone browser server and the VS Code Webview.

## Consequences

- Contributors will run `npm install` to pull `@types/vscode` as a devDependency; runtime dependencies remain zero.
- `src/hosts/vscode/` can be built and tested with `npm run build` and `npm test` using plain `tsc` and `node --test`.
- The extension can be tested in VS Code Extension Development Host (`F5` / `--extensionDevelopmentPath=.`) immediately after implementation.
