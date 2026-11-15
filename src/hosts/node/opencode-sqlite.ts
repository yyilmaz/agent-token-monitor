// Standalone host: strictly read-only OpenCode SQLite reader (R-15, R-18, R-23, ADR 0022).
// Copies opencode.db and any -wal/-shm sidecars to a temporary directory outside the harness root,
// reads only structural columns with node:sqlite, and deletes the temporary directory in finally.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type SqliteModule = { readonly DatabaseSync: typeof DatabaseSyncType };

const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"]);

interface RawSessionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly directory: string;
  readonly title: string | null;
  readonly time_created: number;
}

interface RawMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: string;
  readonly seq: number;
  readonly time_created: number;
  readonly data: string;
}

interface RawPartRow {
  readonly message_id: string;
  readonly session_id: string;
  readonly ordinal: number;
  readonly type: string;
  readonly data: string;
}

function diagnosticLine(code: string, message: string, severity: "error" | "warning" = "error"): string {
  return JSON.stringify({ record: "diagnostic", severity, code, message });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isTransientSqliteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errcode?: unknown; code?: unknown }).errcode ?? (error as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" || code === 5 || code === 11;
}

async function copyIfPresent(src: string, dst: string): Promise<void> {
  try {
    await copyFile(src, dst);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function extractToolInfo(item: Record<string, unknown>): { readonly name: string; readonly command: string | null } | null {
  const name = typeof item.name === "string" && item.name !== "" ? item.name : null;
  if (name === null) return null;
  let command: string | null = null;
  if (SHELL_TOOLS.has(name)) {
    const state = typeof item.state === "object" && item.state !== null ? (item.state as Record<string, unknown>) : null;
    const input = state && typeof state.input === "object" && state.input !== null ? (state.input as Record<string, unknown>) : null;
    const rawCmd = input?.command ?? input?.cmd;
    if (typeof rawCmd === "string") command = rawCmd;
  }
  return { name, command };
}

function sanitizeMessageData(rawJson: string): {
  readonly ok: true;
  readonly time: unknown;
  readonly model: unknown;
  readonly tokens: unknown;
  readonly tools: readonly { readonly name: string; readonly command: string | null }[];
} | { readonly ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const obj = parsed as Record<string, unknown>;
  const tools: { readonly name: string; readonly command: string | null }[] = [];
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === "tool") {
        const info = extractToolInfo(rec);
        if (info !== null) tools.push(info);
      }
    }
  }
  return {
    ok: true,
    time: obj.time ?? null,
    model: obj.model ?? null,
    tokens: obj.tokens ?? null,
    tools,
  };
}

let sqliteModule: Promise<SqliteModule> | null = null;

/**
 * Loads `node:sqlite` only when an OpenCode database exists, so the CLI contract (empty stderr,
 * JSON-only output) holds on Node versions where the module still emits an ExperimentalWarning.
 * Only that one warning is dropped while the module loads (R-15, ADR 0022).
 */
function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      if (text.startsWith("SQLite is an experimental feature")) return;
      return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqliteModule;
}

function readFromCopiedDb(DatabaseSync: typeof DatabaseSyncType, copyPath: string): string[] {
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session_message', 'session_part')").all() as { name: string }[])
        .map((r) => r.name),
    );
    if (!tables.has("session_v2") || !tables.has("session_message")) {
      return [diagnosticLine("opencode_schema_unsupported", "OpenCode database is missing expected session_v2 tables.")];
    }

    const lines: string[] = [];
    const sessions = db
      .prepare("SELECT id, parent_id, directory, title, time_created FROM session_v2 ORDER BY time_created, id")
      .all() as unknown as RawSessionRow[];
    for (const s of sessions) {
      lines.push(
        JSON.stringify({
          record: "session",
          id: s.id,
          parentId: s.parent_id,
          projectPath: s.directory,
          title: s.title,
          timeCreated: s.time_created,
        }),
      );
    }

    const messages = db
      .prepare("SELECT id, session_id, type, seq, time_created, data FROM session_message ORDER BY session_id, seq, id")
      .all() as unknown as RawMessageRow[];
    for (const m of messages) {
      const sanitized = sanitizeMessageData(m.data);
      if (!sanitized.ok) {
        lines.push(diagnosticLine("opencode_malformed_message", "Unreadable OpenCode message record.", "warning"));
        continue;
      }
      lines.push(
        JSON.stringify({
          record: "message",
          id: m.id,
          sessionId: m.session_id,
          type: m.type,
          seq: m.seq,
          timeCreated: m.time_created,
          time: sanitized.time,
          model: sanitized.model,
          tokens: sanitized.tokens,
          tools: sanitized.tools,
        }),
      );
    }

    if (tables.has("session_part")) {
      const parts = db
        .prepare("SELECT message_id, session_id, ordinal, type, data FROM session_part WHERE type = 'tool' ORDER BY session_id, message_id, ordinal")
        .all() as unknown as RawPartRow[];
      for (const p of parts) {
        try {
          const parsed = JSON.parse(p.data) as Record<string, unknown>;
          const tool = typeof parsed === "object" && parsed !== null ? extractToolInfo(parsed) : null;
          if (tool !== null) {
            lines.push(JSON.stringify({ record: "part", messageId: p.message_id, sessionId: p.session_id, tool }));
          }
        } catch {
          lines.push(diagnosticLine("opencode_malformed_part", "Unreadable OpenCode tool part record.", "warning"));
        }
      }
    }

    return lines;
  } finally {
    db.close();
  }
}

/**
 * Reads `opencode.db` strictly read-only by copying the database and any WAL/SHM sidecars
 * to a temporary directory outside the harness root (ADR 0022, R-15).
 */
export async function readOpenCodeSqliteLines(dbPath: string): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = await mkdtemp(join(tmpdir(), "atm-opencode-"));
    try {
      const copyPath = join(tmp, "opencode.db");
      await copyFile(dbPath, copyPath);
      await copyIfPresent(`${dbPath}-wal`, `${copyPath}-wal`);
      await copyIfPresent(`${dbPath}-shm`, `${copyPath}-shm`);
      const { DatabaseSync } = await loadSqlite();
      return readFromCopiedDb(DatabaseSync, copyPath);
    } catch (error) {
      if (attempt === 0 && isTransientSqliteError(error)) continue;
      return [diagnosticLine("opencode_db_unreadable", "Could not read OpenCode SQLite database.")];
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return [diagnosticLine("opencode_db_unreadable", "Could not read OpenCode SQLite database.")];
}
