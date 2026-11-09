# 0013. Local server, data API and dashboard views

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-14, R-15, R-16, R-17, R-18, R-23, R-25, R-26, R-30, R-31, R-32, R-33, R-51, R-63, R-72

## Context

ADR 0002 decides a local backend that serves a JSON API and the frontend, ADR 0005 a single page in plain TypeScript that polls the backend, and ADR 0006 the host interfaces. ADR 0009 defines cache analysis. This ADR defines:

- the usage totals by day, month and session (R-33 view 2) and the open-sessions view (R-33 view 1), both rules with parameters;
- how the server runs, what it exposes, and when it re-reads the logs;
- what each dashboard view shows, so the main screen stays readable within seconds (R-30, R-31).

Session advice (R-60, R-62) is decided in ADR 0017. Report export (R-71) is decided in its own ADR.

## Decision

### Usage totals

**Rule `USE-1`.** Usage is summed per **day**, per **month** and per **session**, each split by harness, effective model (`MODEL-1`) and project:

- token figures: calls, `inputUncached`, `cacheRead`, `cacheWrite`, `output`, `reasoning`, each token field with the number of calls where it is `unknown` (R-16).
- weighted token units for the full period and each harness: sum the per-call rounded load using the configured weights and calculation in ADR 0017. Count calls whose weighted load is unknown separately (R-16, R-51).

A call belongs to the day and month of its timestamp in the time zone `usage.timeZone`. Its default, `"system"`, means the zone the host reports; any IANA zone name (e.g. `"Europe/Istanbul"`) may be set instead. The host passes the resolved zone name to the core next to the "as of" time, so it is an explicit input like the clock (R-10), and every response names it. The core converts with the built-in `Intl.DateTimeFormat`, which needs no host access.

The project is the session's `projectPath` (ADR 0008), or `unknown` when the log has none (Antigravity). It is shown as recorded (R-71).

### Open sessions

**Rule `LIVE-1`.** A session is **open** when its last call is at most `liveView.openWithinSeconds` before the "as of" time. For each open session the view shows harness, effective model, project, context size of the last call, time since the last call, and the **cache status**:

- `missed on last call`: the last call was a cache loss (`LOSS-1`);
- `warm`: otherwise, while the time since the last call is at most the reference lifetime;
- `probably cold`: after that.

The reference lifetime is the one `CAUSE-1` uses: declared, else observed median, else configured (ADR 0009). The status names which one it used. Subagent sessions are listed under their parent.

### Server

- The standalone host is one Node.js process (`node:http`), started with `node dist/src/hosts/node/main.js [--config <path>] [--port <n>]`. It binds to **`127.0.0.1` only** (R-14). Without `--port` it asks the operating system for a free port (ADR 0005), and it prints the URL. It does not open a browser.
- **Only `GET` is served.** Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused, so a web page in the user's browser cannot reach the API through a rebound domain name. No CORS headers are sent.
- It serves the compiled frontend files and the JSON API below, and nothing else. It writes nothing anywhere: no cache, log or state file (R-15).

### When the logs are re-read

- On a request, if more than `ui.pollIntervalSeconds` have passed since the last check, the host lists the log files and reads their size and modification time (a read-only `stat`). When this fingerprint differs from the last one, it reads the new and changed files again (ADR 0014), re-runs the cross-file adapter step and the analysis, and keeps the result in memory. A changed configuration file is detected the same way.
- The check and rebuild run in the background: requests are answered from the previous result meanwhile, so the page never waits for a rebuild. Only the first request after start waits.
- The "as of" time is the host clock at each request. Only the parts that depend on it (open sessions, session advice) are recomputed per request; the rest is reused until the fingerprint changes.
- A configuration error replaces every response with the error list and no results (ADR 0007). Adapter diagnostics are always included (R-23).

### Data API

All responses are JSON with sorted keys (ADR 0007) and carry `asOf`, `timeZone` and the effective configuration (R-10, R-63). Every figure keeps its rule ID and its link to calls (R-17); the call list behind a figure is fetched from the session endpoint.

| Endpoint | Content | Polled |
|---|---|---|
| `GET /api/overview` | open sessions (`LIVE-1`), session advice (`ADVICE-1`), today and this month (`USE-1`), diagnostics counts | yes |
| `GET /api/usage?by=day\|month\|session` | `USE-1` totals | when the view is open |
| `GET /api/cache` | lifetime groups, declared lifetimes per model and miss-cause totals (ADR 0009) | when the view is open |
| `GET /api/sessions/<id>` | one session: its calls in order with tokens, cache class, loss, cause and source lines | when opened |
| `GET /api/diagnostics` | all adapter diagnostics | when opened |

The page polls only the endpoint of the view on screen, every `ui.pollIntervalSeconds`. Each successful response carries the error and warning total (`diagnosticCount`) for the navbar link (R-23).

### Dashboard views

One page, one view at a time, chosen from a fixed tab bar (R-33). The first screen puts open sessions first so the developer can see current activity without scrolling (R-30).

1. **Now:** open sessions with cache status and session advice.
2. **Usage:** a summary and daily total-token chart for today or a configured date range, with a breakdown by harness, model or project. Three charts below the breakdown show daily input tokens (uncached input, cache reads and cache writes), output tokens and weighted token units over the same range. Each chart can show all harnesses combined or show individual harnesses whose bars can be toggled in the legend. The charts sum known counts and leave days with only unknown counts blank. Today uses the configured usage time zone and compares with the previous calendar day.
3. **Cache:** survived and gone counts by gap band, observed and declared lifetimes, miss causes with re-read tokens.

A session row anywhere opens the **session drill-down**: its call timeline, context growth, each cache loss with its cause, and its subagents. Unknown values are written `unknown` (R-16); derived values carry their rule ID. Prompt text, code and file contents are never shown, because the API never carries them (R-18).

The dashboard uses Bootstrap components, including Navbar for top navigation (ADR 0019). Bootstrap and the dashboard CSS variables follow the selected theme, defaulting to the system light or dark preference.

### Parameters

| Key | Default |
|---|---|
| `usage.timeZone` | `"system"` |
| `liveView.openWithinSeconds` | `1800` |
| `ui.pollIntervalSeconds` | `5` (exists) |

## Alternatives considered

- **One snapshot endpoint with everything:** simplest API, but sends megabytes every few seconds.
- **Server-sent events or WebSocket push:** fresher, but ADR 0005 chose polling, and push adds a second channel to keep working in a Webview.
- **File watching (`fs.watch`) instead of a fingerprint check:** reacts faster, but recursive watching behaves differently on each platform, and polling at the page's own interval is fast enough for a view refreshed every few seconds.
- **Days in UTC:** no time-zone input needed, but a day that ends at 03:00 local time is not what a user means by "today".
- **Opening the browser automatically:** convenient, but runs an external program; the printed URL is enough.

## VS Code compatibility

- `USE-1` and `LIVE-1` are pure functions in `src/core/analysis/`; the time zone and the "as of" time are inputs (ADR 0006). `Intl.DateTimeFormat` with time zones is available in the extension host and in Webviews.
- The HTTP server is the standalone host only. In VS Code, the same endpoints become message types on the Webview channel (ADR 0005): the request `{ "endpoint": "/api/overview" }` returns the same JSON. The data-access module is the only frontend code that changes.
- The fingerprint check uses the host's `LogSource`; the VS Code host may use file system watchers instead, with no core change.
- `"system"` resolves to the zone the extension host reports. Colors switch to VS Code theme variables in the Webview (R-26 item 4).

## Consequences

- The first screen stays small; details live one click away (R-30, R-31).
- Starting the product is one command, and nothing is written to disk.
- "Today" follows the user's clock, and the zone used is visible in every response.
- Only changed files are read again (ADR 0014); the analysis still runs over all calls on every change.
