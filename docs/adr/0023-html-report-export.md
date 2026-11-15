# 0023. Self-contained HTML report export

- Status: Accepted
- Date: 2026-11-15
- Requirements: R-10, R-14, R-18, R-25, R-26, R-71

## Context

[ADR 0002](0002-frontend-backend-architecture.md) specifies that report export (R-71) is a backend endpoint returning the frontend as one self-contained HTML file with the analysis JSON embedded, and [ADR 0013](0013-server-data-api-and-dashboard.md) deferred the details to a dedicated ADR.

The exported report must:
- work completely offline when opened from `file://` without external CDNs or network calls (R-14);
- be byte-identical for identical logs, configuration, and `asOf` timestamp (R-10, R-71);
- embed the active configuration (R-10, R-71) and all view data including per-session drill-downs while preserving R-18 privacy;
- reuse the same frontend code without introducing an external bundler ([ADR 0005](0005-frontend-single-page-typescript.md)) and without weakening the live server's Content Security Policy.

## Decision

1. **Endpoint and UI trigger.** The standalone server exposes `GET /api/report`, returning `text/html; charset=utf-8` with `Content-Disposition: attachment; filename="agent-token-monitor-report.html"`. The dashboard navbar includes an **Export** link (`<a href="api/report" download="agent-token-monitor-report.html">`) that triggers the download; in offline report mode this link is hidden.
2. **Embedded data and offline mode.** The report embeds a single JSON payload serialized with `stableStringify` ([ADR 0007](0007-configuration-file.md)) inside `<script type="application/json" id="report-data">` (with `<` escaped as `\u003c` so `</script>` cannot close the tag prematurely). The payload contains `asOf`, `timeZone`, `configuration`, `overview`, `usageByDay`, `cache`, `diagnostics`, and `sessions` (every session's drill-down payload keyed by sorted session ID). The frontend data layer (`web/src/data.ts`) and entry point (`web/src/main.ts`) detect `#report-data`, serve all views from the embedded JSON without `fetch`, and disable polling.
3. **Inlining styles and ES modules.** All stylesheets (`bootstrap.min.css`, `uPlot.min.css`, `style.css`) are inlined in `<style>` and classic vendor scripts (`uPlot.iife.min.js`) are inlined before the application script. Compiled frontend ES modules (`dist/web/src/**`) and vendored Bootstrap ES modules (`web/vendor/bootstrap/js/**`) are ordered deterministically by topological dependency traversal from the entry modules (`vendor/bootstrap/js/drawer.js`, `js/main.js`), rewritten into a small inline module registry, and placed in a single `<script>` at the end of `<body>`. A `<meta http-equiv="Content-Security-Policy">` tag (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';`) blocks any network requests when opened offline, while the live server keeps its strict `script-src 'self'; style-src 'self'` CSP unchanged.
4. **Host-agnostic assembly in `src/core/`.** Building the `ReportData` snapshot and assembling the HTML string from pre-read asset strings live in `src/core/api/report.ts` with no Node.js or filesystem imports. Hosts only read the static/script/vendor files and pass them in.

## Alternatives considered

- **Adding an external bundler (esbuild, Rollup, Vite):** adds a build dependency and toolchain complexity rejected by [ADR 0005](0005-frontend-single-page-typescript.md).
- **Keeping `<script type="module">` with `importmap` / `data:` URIs:** fails or behaves inconsistently across browsers when opened via `file://`.
- **Fetching only summary views and omitting per-session drill-downs:** would leave session links broken in the offline report.

## VS Code compatibility

Because `buildReportData` and `buildHtmlReport` are pure functions in `src/core/api/report.ts` accepting pre-read asset strings, the future VS Code extension host (R-25, R-26) can read the same packaged assets from `extensionUri`, call the same functions, and write the resulting HTML string via `vscode.window.showSaveDialog` without starting an HTTP server.

## Consequences

- One self-contained HTML file works offline via `file://` with all dashboard views, charts, theme toggle, and session drill-downs intact.
- Output is deterministic for identical inputs, configuration, `asOf`, and `timeZone`.
- Frontend modules must stick to standard static ES `import`/`export` syntax supported by the inline module combiner.
