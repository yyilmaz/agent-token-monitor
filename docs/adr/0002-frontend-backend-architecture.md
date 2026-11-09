# 0002. Plain frontend-backend architecture on localhost

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-14, R-15, R-22, R-30, R-32, R-33, R-70, R-71

## Context

The product must read harness logs from the user's home directory (R-22), update live (R-32), stay strictly local (R-14) and produce deterministic, testable results (R-10, R-70, R-71).

A browser page cannot read `~/.gemini`, `~/.claude` or `~/.codex` by itself. The only exception, Chrome's File System Access API, requires picking the folder by hand, is unsupported in Safari and Firefox, and cannot reliably watch files in the background. A process running on the user's machine must therefore read the logs.

## Decision

Use a plain two-part architecture, both parts running only on the user's machine:

1. **Backend:** a single local process bound to `127.0.0.1`. It reads harness logs read-only (R-15), runs the analysis and serves a JSON API. It also serves the frontend files.
2. **Frontend:** a browser UI that only calls the backend API and renders the result. It contains no analysis logic.

Inside the backend, the code is layered:

- **Adapters:** one per harness; each converts native logs into the normalized model (R-22).
- **Analysis:** pure functions over the normalized model (usage totals, cache classification, lifetime, TTL simulation, rules). No I/O, no clock reads; the "as of" time is a parameter (R-10).
- **HTTP layer:** thin. It calls adapters and analysis, and holds no business logic.

Tests (R-70, R-71) call adapters and analysis directly, without starting the server.

Report export (R-71) is a backend endpoint that returns the frontend as one self-contained HTML file with the analysis JSON embedded. No separate CLI is built.

## Alternatives considered

- **Single HTML file containing all logic:** cannot read local logs reliably, makes adapter tests depend on a browser, and would re-parse large logs in the browser on every refresh.
- **Separate engine CLI + server + UI:** adds a third deliverable without a requirement that needs it.
- **Desktop app shell (e.g. Electron, Tauri):** heavier to build and audit; nothing in the SRS requires a native window.

## VS Code compatibility

- Adapters and analysis do not depend on the HTTP layer, so the VS Code extension runs them directly in the extension host (R-25, R-26).
- In VS Code, the Webview replaces the browser and Webview messaging replaces the JSON API. The frontend structure stays the same ([ADR 0005](0005-frontend-single-page-typescript.md)).

## Consequences

- Users start one local process and open one localhost URL.
- The backend language ([ADR 0004](0004-backend-language-typescript.md)) and frontend technology ([ADR 0005](0005-frontend-single-page-typescript.md)) build on this structure.
- Because analysis is pure and clock-free, any result can be reproduced from logs, configuration and the "as of" time.
