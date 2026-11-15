# 0022. OpenCode SQLite adapter

- Status: Accepted
- Date: 2026-11-15
- Requirements: R-10, R-14, R-15, R-16, R-18, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-32, R-33, R-70, R-72

## Context

Phase 2 adds OpenCode to the dashboard (R-21). Unlike Claude Code, Antigravity, and Codex, which store transcripts as JSONL or text files, OpenCode stores its sessions and messages in a SQLite database (`opencode.db`) under `~/.local/share/opencode` (configured via `logRoots.opencode`), typically in WAL (Write-Ahead Logging) mode with `opencode.db-wal` and `opencode.db-shm` sidecar files.

This introduces two architectural constraints:

1. **Strict read-only access (R-15):** Opening a WAL-mode SQLite database directly in its harness directory—even with `readOnly: true`—causes SQLite to acquire file locks and read/mmap/create `-shm` or `-wal` sidecar files inside `~/.local/share/opencode`, which violates R-15 ("the product MUST NOT create, modify, move, rename, truncate, lock or delete anything inside them").
2. **Core/host boundary and VS Code compatibility (R-25, R-26, ADR 0006):** `src/core` may not import `node:*` modules or touch the filesystem, and the product must remain shippable as a native VS Code extension with zero external runtime dependencies (ADR 0004).

## Decision

### 1. Strictly read-only SQLite access via copy-to-temp

- **OPN-1 (Copy-to-temp read strategy):** The host never opens `opencode.db` inside the harness log root. When `opencode.db` is detected under a configured `opencode` log root, the host copies `opencode.db` and any present `opencode.db-wal` and `opencode.db-shm` sidecars (using read-only `copyFile` / `stat`) into a fresh temporary directory under `os.tmpdir()`, opens the copy with Node's built-in `node:sqlite` `DatabaseSync`, reads the required rows, closes the database, and removes the temporary directory in a `finally` block.
- **OPN-2 (Change detection):** The host fingerprints `opencode.db` together with `opencode.db-wal` (size and `mtimeMs`, or `"missing"` when absent) so uncheckpointed writes to the WAL trigger a refresh on the next poll (R-32). If a concurrent write by OpenCode causes a transient read error on the copy, the host retries once and otherwise emits a visible diagnostic (R-23) without crashing or skipping silently.

### 2. Zero-dependency runtime using `node:sqlite`

- **OPN-3 (Built-in `node:sqlite`):** Use Node.js's built-in `node:sqlite` (`DatabaseSync`) in `src/hosts/node/` (and the future `src/hosts/vscode/`). No external npm packages or native binary modules are added (ADR 0004, R-26).

### 3. Host/core boundary and two-step adapter

- **OPN-4 (Boundary separation):** `node:sqlite` and the copy-to-temp logic stay strictly in the host (`src/hosts/node/`). The host queries only the non-sensitive structural columns needed for analysis (`session_v2`, `session_message`, `session_part` if present) and passes them as a `LogFile` of deterministic JSON lines (ordered by `session_id`, `seq`, `id`) to `src/core/adapters/opencode/`.
- **OPN-5 (Pure core adapter):** `src/core/adapters/opencode/` implements the standard two-step ADR 0014 contract (`readFile` and `combine`) in pure TypeScript with no `node:*` imports, preserving `test/core/boundary-guard.test.ts` and allowing fixture tests to run directly from anonymized JSON-line fixtures without SQLite or filesystem access. A host test verifies the copy-to-temp `node:sqlite` path against an anonymized WAL-mode SQLite fixture database and confirms zero writes/sidecars in the source directory (R-15).

### 4. Normalization and privacy

- **OPN-6 (Token and session mapping):**
  - Map `session_v2` rows to `Session` (`id`, `parent_id` for subagent linking, `directory` as `projectPath`, `title`, `time_created`).
  - Map `session_message` rows with `type = 'assistant'` and `type = 'compaction'` to `Call` records using `data.tokens` (`input` → `inputUncached`, `cache.read` → `cacheRead`, `cache.write` → `cacheWrite`, `output` → `output`, `reasoning` → `reasoning`), `data.model`, and `data.time.completed ?? data.time.created ?? time_created`. Missing or negative values remain `unknown` (`null`, R-16).
  - Emit `user_turn` events for `type = 'user'` messages and `compaction` events (plus compaction calls when `type = 'compaction'` records tokens) for `type = 'compaction'` messages.
  - Extract tool names and `shellClasses` from `data.content` tool items (and `session_part` when present), discarding prompt text, reasoning text, and tool arguments immediately (R-18).
- **OPN-7 (Diagnostics):** Unsupported schema versions, missing expected tables, or malformed JSON in `data` columns emit fixed diagnostic messages without exposing user content (R-18, R-23).

## Alternatives considered

- **Opening `opencode.db` directly with `readOnly: true`:** Still causes SQLite in WAL mode to open/mmap/lock `-shm` and `-wal` inside `~/.local/share/opencode`, violating R-15.
- **Opening `file:.../opencode.db?immutable=1`:** Avoids touching `-wal` and `-shm`, but SQLite's `immutable=1` ignores `-wal` completely, so active sessions with uncheckpointed WAL transactions would appear stale or missing.
- **Third-party SQLite packages (`better-sqlite3`, `sql.js`):** `better-sqlite3` requires a native C++ addon (violating R-26.1 and ADR 0004); `sql.js` adds a WASM runtime dependency when `node:sqlite` is already built into Node.js.
- **Putting `node:sqlite` directly in `src/core/adapters/opencode/`:** Breaks the `src/core` host-independence boundary (ADR 0006, `boundary-guard.test.ts`) and couples adapter unit tests to SQLite files.

## VS Code compatibility

- `src/core/adapters/opencode/` is pure TypeScript and runs unchanged inside the VS Code extension host (R-25, R-26).
- VS Code 1.108.1 bundles Node.js 22.21.1 and Antigravity bundles Node.js 24.21.0 (ADR 0006); both include `node:sqlite` (`DatabaseSync`) unflagged without native addons or external binaries.
- The future `src/hosts/vscode/` implements the same copy-to-temp `node:sqlite` extraction using `os.tmpdir()` and passes the resulting `LogFile` to the unchanged core adapter.

## Consequences

- Harness directories remain strictly untouched (zero writes, locks, or sidecars) while still capturing live uncheckpointed WAL transactions.
- `src/core` remains 100% pure and testable from anonymized text fixtures, while host tests pin the SQLite WAL copy-to-temp behavior.
- Copying `opencode.db` on change adds a brief disk copy proportional to database size, mitigated by fingerprinting `opencode.db` + `opencode.db-wal` so copies happen only when data changes.
- Minimum Node.js runtime with unflagged `node:sqlite` is 22.13.0 (`engines.node` in `package.json` is `>=22.13`; VS Code's 22.21.1 and Antigravity's 24.21.0 both satisfy this).
