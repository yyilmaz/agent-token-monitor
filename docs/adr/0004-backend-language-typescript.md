# 0004. Backend language: TypeScript on Node.js, zero runtime dependencies

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-03, R-10, R-13, R-14, R-22, R-25, R-70

## Context

ADR 0002 defines a local backend that reads harness logs, analyzes them and serves a JSON API. The product should eventually ship as a VS Code extension (R-25). VS Code extensions run on the Node.js runtime that VS Code ships, and their UI runs in a Webview (HTML/JS).

## Decision

- The backend is written in **TypeScript** and runs on **Node.js**.
- **Zero runtime dependencies:** only Node.js built-in modules (`node:fs`, `node:http`, `node:path`, …). Any third-party runtime package needs its own ADR.
- **Development dependencies are minimal:** `typescript` and `@types/node` ([ADR 0006](0006-project-layout-and-tooling.md)). Tests use the built-in `node:test` runner.
- **Analysis and adapters are host-independent:** pure TypeScript modules with no dependency on HTTP, the filesystem layer or VS Code APIs. The same modules run in the standalone server and, later, in the VS Code extension host.
- The minimum Node.js version is set in [ADR 0006](0006-project-layout-and-tooling.md), below the Node.js versions bundled with VS Code and Antigravity.

## Alternatives considered

- **Python:** readable and auditable, but the VS Code extension would require users to install Python and run the backend as a separate process, and the project would maintain two languages and two toolchains.
- **Go:** single binary, but cannot run inside the VS Code extension host and adds a second language.

## VS Code compatibility

- The extension host runs the same TypeScript modules on its bundled Node.js, with no extra install (R-25, R-26).
- The zero-runtime-dependency rule keeps the extension package small and auditable.

## Consequences

- One language across adapters, analysis, frontend and the future extension; shared types are defined once.
- The VS Code extension needs no extra install: its bundled Node.js runs the backend code directly.
- The standalone dashboard needs Node.js. Most target users already have it, because Claude Code and Codex are installed through npm.
- npm supply-chain risk is contained by the zero-runtime-dependency rule.
- Token counts are integers far below JavaScript's safe-integer limit (2^53 − 1), so determinism (R-10) is not at risk from number precision. Formatting and sorting rules must still be explicit.
