# 0005. Frontend: single HTML page, plain TypeScript, vendored uPlot, polling

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-14, R-25, R-30, R-31, R-32, R-33, R-71

## Context

ADR 0002 defines a frontend that only renders data from the backend. The UI must be very simple (R-30), live (R-32), fully offline with no network calls (R-14), exportable as one reproducible file (R-71), and reusable inside a VS Code Webview later (R-25). Five views are required (R-33), including time series and distributions.

## Decision

1. **One HTML page with plain TypeScript, compiled by `tsc` (ADR 0004).** Bootstrap provides dashboard components, layout, and color modes (ADR 0019). The frontend loads vendored files directly without a bundler.
2. **Charts: uPlot** (MIT), vendored into the repository as a pinned file with its license. Nothing loads from a CDN (R-14).
3. **Live updates by polling:** the page asks the backend for fresh data every few seconds. The interval lives in configuration (R-72).
4. **Rules for future VS Code Webview reuse** (R-25):
   - **Single data-access layer:** all data comes through one module. In the browser it uses `fetch` to the backend; in VS Code it will use Webview messaging (`postMessage`). No other module knows where data comes from.
   - **CSP-safe code:** no inline `<script>`, no inline event handlers (`onclick=`), no `eval` or `new Function`. Scripts and styles live in separate files. The exported single-file report (R-71) inlines them at export time.
   - **No fixed port:** the backend asks the OS for a free port and reports it, so an extension can start it and connect.
   - **Assets by relative path only**, so they can be remapped to Webview resource URIs.

## Alternatives considered

- **Plain JS with hand-drawn SVG charts:** zero dependencies, but re-implementing time-series and distribution charts is unnecessary work.
- **Framework with a build (React, Vue, Svelte + Vite):** too heavy for five views and the simplicity goal (R-30). Adds a bundler toolchain.
- **Server-rendered HTML + HTMX:** still needs JavaScript for charts, adds a dependency and makes the single-file export harder.

## VS Code compatibility

The rules in decision 4 exist for this: the same page runs in a VS Code Webview, with the data-access module switched from `fetch` to `postMessage` and asset paths mapped to Webview resource URIs (R-25, R-26).

## Consequences

- Contributors need only Node.js and `tsc`.
- The same page serves the standalone dashboard, the exported report and, later, the VS Code Webview.
- Keeping the UI organized without a framework requires discipline: one module per view, and shared rendering helpers.
- If the UI outgrows this approach, this ADR is revised.
