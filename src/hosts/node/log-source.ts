// Standalone host: reads harness log files strictly read-only (R-15).
// Only readdir, readFile and stat are used. Nothing is ever created, changed or locked under a log root.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { LogFile, LogSource } from "../../core/host/index.js";
import { compareStrings } from "../../core/order.js";
import { readOpenCodeSqliteLines } from "./opencode-sqlite.js";

const SQLITE_DB_FILE = /(?:^|\/)opencode\.db$/;

export class FsLogSource implements LogSource {
  /** @param roots log root key (e.g. "claudeCode:0") → absolute directory */
  constructor(private readonly roots: Readonly<Record<string, string>>) {}

  async list(logRoot: string, pattern: RegExp): Promise<readonly string[]> {
    const dir = this.rootDir(logRoot);
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .map((entry) => relative(dir, join(dir, entry)).split(sep).join("/"))
      .filter((path) => pattern.test(path))
      .sort(compareStrings);
  }

  async read(logRoot: string, file: string): Promise<LogFile> {
    const fullPath = join(this.rootDir(logRoot), ...file.split("/"));
    if (SQLITE_DB_FILE.test(file)) {
      return { logRoot, file, lines: await readOpenCodeSqliteLines(fullPath) };
    }
    const text = await readFile(fullPath, "utf8");
    return { logRoot, file, lines: text.split(/\r?\n/) };
  }

  /** Size and modification time of one file, used to notice changes without reading it (ADR 0013, ADR 0024). */
  async statEntry(logRoot: string, file: string): Promise<{ readonly fingerprint: string; readonly mtimeMs: number }> {
    const fullPath = join(this.rootDir(logRoot), ...file.split("/"));
    const info = await stat(fullPath);
    const base = `${info.size}:${info.mtimeMs}`;
    if (!SQLITE_DB_FILE.test(file)) return { fingerprint: base, mtimeMs: info.mtimeMs };
    const wal = await optionalStat(`${fullPath}-wal`);
    const walStamp = wal === null ? "missing" : `${wal.size}:${wal.mtimeMs}`;
    const mtimeMs = wal === null ? info.mtimeMs : Math.max(info.mtimeMs, wal.mtimeMs);
    return { fingerprint: `${base}|${walStamp}`, mtimeMs };
  }

  /** Size and modification time of one file, used to notice changes without reading it (ADR 0013). */
  async fingerprint(logRoot: string, file: string): Promise<string> {
    return (await this.statEntry(logRoot, file)).fingerprint;
  }

  private rootDir(logRoot: string): string {
    const dir = this.roots[logRoot];
    if (dir === undefined) throw new Error(`unknown log root ${logRoot}`);
    return dir;
  }
}

/** Log root keys for one harness, in configuration order: "<harness>:<index>". */
export function logRootKeys(harness: string, dirs: readonly string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  dirs.forEach((dir, index) => (keys[`${harness}:${index}`] = dir));
  return keys;
}

/** Lists and reads every matching file under the given log roots. */
export async function readLogFiles(source: LogSource, logRoots: readonly string[], pattern: RegExp): Promise<LogFile[]> {
  const files: LogFile[] = [];
  for (const logRoot of logRoots) {
    for (const file of await source.list(logRoot, pattern)) files.push(await source.read(logRoot, file));
  }
  return files;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function optionalStat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
