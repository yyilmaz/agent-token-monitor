# 0006. Project layout, module system and tooling

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-14, R-15, R-22, R-24, R-25, R-26, R-70, R-72

## Context

ADR 0004 fixes TypeScript on Node.js with zero runtime dependencies and host-independent adapters and analysis. ADR 0005 fixes a single-page frontend compiled by `tsc`. R-26 requires every decision to keep the product shippable as a native VS Code extension: host-specific concerns must sit behind narrow interfaces, and only what the VS Code extension host and Webview provide may be used.

Before writing code we need a layout that makes these boundaries hard to break by accident, a module system that works in both hosts, a minimum Node.js version, and a test setup.

Runtime compatibility checks:

| Host | Bundled Node.js | `require(esm)` |
|---|---|---|
| VS Code 1.108.1 (Electron 39.2.7) | 22.21.1 | supported |
| Antigravity | 24.21.0 | supported |

## Decision

### Layout

```
src/
  core/                  host-independent; no Node.js, DOM or VS Code APIs
    model/               normalized types (own ADR)
    adapters/<harness>/  parse native log lines into the model
    analysis/            pure functions: usage, cache, lifetime, TTL replay, rules
    api/                 data API payloads shared by every host (ADR 0013)
    config/              config schema, validation and merge (ADR 0007)
    host/                host interfaces (types only)
  hosts/
    node/                standalone host: filesystem, change checks, HTTP server, CLI entry
                         (hosts/vscode/ is added when the extension is built)
web/
  src/                   frontend TypeScript: one module per view, one data-access module
  static/                index.html, CSS
  vendor/uplot/          pinned uPlot build and its LICENSE
  vendor/bootstrap/      pinned Bootstrap stylesheet, drawer modules and LICENSE
test/
  fixtures/<harness>/    anonymized fixture logs only (R-18, R-70)
  core/                  tests of adapters and analysis, no server
  hosts/node/
config/
  default.json           shipped default configuration (ADR 0007)
docs/
```

### Host interfaces

`src/core/host/` defines, as types only, everything the core needs from its environment:

- **LogSource:** lists log files under configured roots and returns their contents as lines. Adapters never open files; they declare which file patterns they read and parse the lines they are given. Each adapter reads one file at a time and then combines the per-file results (ADR 0014).
- **ConfigSource:** returns the raw user configuration text (ADR 0007).
- **Change notifications:** tell the host when logs or configuration changed.
- **The "as of" time** is a plain parameter to analysis, supplied by the host (R-10). The core never reads the clock.

`src/hosts/node/` implements these with `node:fs`, `node:http` and `node:path`. A future `src/hosts/vscode/` implements the same interfaces with VS Code APIs.

### Boundary enforcement

One guard test enforces the boundaries; there is no separate build per folder:

- Files in `src/core` may import only relative paths inside `src/core`. Any other import (`node:*`, `vscode`, a package) fails the test.
- Files in `src/core` may not use host globals (`process`, `require`, `window`, `document`, `fetch`), the clock (`Date.now`, argument-less `new Date()`, `performance.now`) or randomness (`Math.random`, `crypto` random functions) (R-10).
- The frontend imports **types only** from `src/core` (the frontend holds no analysis logic, ADR 0002).

### Module system and targets

- ES modules everywhere: `"type": "module"` in `package.json`, `"module": "nodenext"`.
- Compilation target `es2023`.
- Minimum Node.js: **22.12** (`engines.node: ">=22.12"`), the first 22.x release with unflagged `require(esm)`. This is below both measured host runtimes.

### Tooling

- Build: plain `tsc` with one `tsconfig.json` for the whole repository. Output goes to `dist/`, which is not committed.
- Tests: compiled with the rest, run with the built-in `node --test` on `dist/test/`. No type-stripping, no test framework.
- Development dependencies: `typescript` and `@types/node`, both pinned to exact versions, with the lockfile committed. `@types/node` is pinned to the 22.x line so code cannot use Node.js APIs newer than the minimum version.
- `npm` scripts: `build`, `test`.

## Alternatives considered

- **One flat `src/` with folder conventions only:** nothing would stop an adapter from importing `node:fs` or analysis from reading the clock, so R-25 and R-26 would depend on review discipline.
- **A separate TypeScript build per folder (project references):** the compiler would catch boundary violations, but it adds several configuration files and build steps for what one guard test already catches.
- **Adapters that read files themselves:** shorter code, but ties adapters to `node:fs` and makes fixture tests need real files and paths.
- **CommonJS for the backend:** loads in every VS Code version, but the frontend must be ES modules in the browser without a bundler, so the project would mix two module systems. Both measured hosts load ES modules through `require(esm)`.
- **Running tests with Node.js type stripping:** no compile step for tests, but behavior differs across Node.js 22.x releases, and tests would not run the same compiled output the product ships.
- **A test framework (Vitest, Jest):** more features, but adds a dependency tree. `node:test` covers fixture tests.

## VS Code compatibility

- The extension adds `src/hosts/vscode/`, which implements the host interfaces with Node.js file access, VS Code file system watchers and a Webview data channel built on `postMessage`. `src/core` and `web/` are reused unchanged.
- The extension entry point, whether CommonJS or ES module, loads `dist/core` directly: ES modules load natively or through `require(esm)`, which VS Code 1.108.1 (Node.js 22.21.1) supports. Antigravity (Node.js 24.21.0) supports it as well.
- The compiled frontend uses relative paths only, so the extension can map them to Webview resource URIs (ADR 0005).
- The extension can be packaged from `dist/` without a bundler. If bundling is later wanted for load time, the bundler is a development dependency and needs its own ADR.

## Consequences

- Adapters and analysis are testable from fixture text alone, with no filesystem and no server.
- Crossing a host boundary by accident fails the test suite, not just a review.
- Raising the minimum Node.js version later (for example when VS Code moves to Node.js 24) is a configuration change, not a restructure.
