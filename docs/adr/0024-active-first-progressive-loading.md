# 0024. Active-first progressive log loading

- Status: Accepted
- Date: 2026-11-21
- Requirements: R-10, R-15, R-16, R-23, R-25, R-26, R-30, R-32, R-33, R-72

## Context

`AnalysisStore` keeps parsed file results in memory only and writes nothing to disk (ADR 0014, R-15). On cold start, its cache is empty, so the very first `/api/*` request blocks until every matching log file across all configured harnesses has been read, parsed, and analyzed.

Over time, harness log directories grow to multiple gigabytes (thousands of JSONL files). Reading and parsing the entire history on cold start blocks the dashboard for ~15–20+ seconds before any UI renders. However, users opening the dashboard primarily want to see **open sessions now** (R-33.1) immediately, while full historical views (`Usage`, `Cache`, and historical advice baselines) can finish loading in the background.

## Decision

### 1. Two-phase cold-start in `AnalysisStore`

On the initial load (`this.state === null`), `AnalysisStore` splits work into two phases:

1. **Discovery and `stat` sweep:** List matching files and collect their fingerprints (`size` + `mtimeMs`).
2. **Phase 1 (Active-first pass):** Immediately read and parse only:
   - Log files whose `mtimeMs >= now - config.liveView.openWithinSeconds * 1000` (reusing the existing configured threshold, R-72),
   - Session index files under `sessionIndexRoots` (small metadata files that supply titles and annotations for open sessions).
   - Run `combine` and `analyze` over this active subset and publish `this.state` immediately so the dashboard renders without waiting for older history.
3. **Phase 2 (Background history pass):** Immediately schedule the remaining older files to be read and parsed in the background (yielding between batches so the event loop stays responsive to `/api/*` requests), then rebuild `this.state` with the complete dataset.

One-shot CLI invocations (`--status`) wait for the complete load (`store.idle()`) so CLI output is never partial.

### 2. Transparent loading status in API and UI

While Phase 2 is in progress, `Analysis` / API responses include a deterministic loading status (e.g. `historyLoading: { totalFiles, loadedFiles }`).

The dashboard displays a clear, non-intrusive notice whenever `historyLoading` is present, informing the user that older log files are still being read in the background and that `Usage`, `Cache`, and historical advice baselines will update automatically when complete (R-16, R-23, R-30). The existing polling loop (`ui.pollIntervalSeconds`, R-32) refreshes the view automatically once Phase 2 finishes.

## Alternatives considered

- **Persistent on-disk parsed cache:** Eliminates re-parsing unchanged files across restarts, but writes files to disk, requires cache invalidation across versions, and still has a slow first-ever launch. Can be added later as a complementary ADR if needed.
- **Reading only active files permanently:** Would break `Usage` (R-33.2), `Cache` (R-33.3), and historical advice baselines (R-60).
- **Separate `Now`-only endpoint:** Duplicates analysis and store logic and still blocks if the user switches to `Usage` or `Cache` before history is ready.

## VS Code compatibility

- `AnalysisStore` is shared by both the standalone HTTP server and the VS Code `DashboardController` (`src/hosts/vscode/panel.ts`, ADR 0021).
- Both phases run in pure TypeScript on the VS Code extension host's Node.js runtime with no native modules or new dependencies (R-26).
- The Webview receives the same `dispatchApi` JSON payload (including `historyLoading`) via `postMessage`, and its existing polling loop updates the UI automatically when Phase 2 finishes.

## Consequences

- Initial dashboard startup drops from ~15–20+ seconds to ~1 second or less on large log histories.
- During the brief window while Phase 2 runs, `Usage`, `Cache`, and historical advice baselines reflect only active files; the UI notice makes this explicit.
- Once Phase 2 finishes, the resulting `Analysis` is identical to a single-pass full load (preserving R-10 and R-71).
