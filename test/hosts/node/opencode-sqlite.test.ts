// Host tests for strictly read-only OpenCode WAL-mode SQLite reading (R-15, R-18, R-23, ADR 0022).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { defaultConfigPath } from "../../../src/hosts/node/config.js";
import { readOpenCodeSqliteLines } from "../../../src/hosts/node/opencode-sqlite.js";
import { AnalysisStore, type StoreState } from "../../../src/hosts/node/store.js";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");

function createTestDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT,
      time_created INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_part (
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created) VALUES (?, ?, ?, ?, ?, ?)").run(
    "s1",
    "p1",
    null,
    "/workspace/demo",
    "Demo session",
    1793000000000,
  );
  db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)").run(
    "m1",
    "s1",
    "assistant",
    1,
    1793000001000,
    JSON.stringify({
      time: { created: 1793000001000, completed: 1793000002000 },
      model: { id: "model-alpha", providerID: "opencode" },
      tokens: { input: 500, output: 50, reasoning: 10, cache: { read: 1000, write: 0 } },
      content: [
        { type: "text", text: "PROMPT_SECRET_DO_NOT_LEAK" },
        { type: "tool", name: "shell", state: { input: { command: "git status" } } },
      ],
    }),
  );
  return db;
}

async function settled(store: AnalysisStore, now: number): Promise<StoreState> {
  await store.current(now);
  await store.idle();
  return store.current(now);
}

describe("OpenCode SQLite host reader (R-15, ADR 0022)", () => {
  const root = mkdtempSync(join(tmpdir(), "atm-opencode-host-"));
  after(() => {
    try {
      chmodSync(join(root, "readonly-dir"), 0o755);
    } catch {
      // ignore if not created
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("loads node:sqlite lazily without printing its ExperimentalWarning to stderr (ADR 0022, ADR 0013)", () => {
    const dbDir = join(root, "warning-dir");
    mkdirSync(dbDir, { recursive: true });
    createTestDb(dbDir).close();
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../../src/hosts/node/opencode-sqlite.js")).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(async (m) => {
      const lines = await m.readOpenCodeSqliteLines(${JSON.stringify(join(dbDir, "opencode.db"))});
      process.stdout.write(String(lines.length));
    });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
    assert.notEqual(result.stdout, "0");
  });

  it("reads uncheckpointed WAL writes and refreshes AnalysisStore when -wal changes (R-15, R-18)", async () => {
    const dbDir = join(root, "wal-dir");
    mkdirSync(dbDir, { recursive: true });
    const db = createTestDb(dbDir);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ logRoots: { claudeCode: [], antigravity: [], codex: [], opencode: [dbDir] } }),
    );
    const store = new AnalysisStore({
      defaultsPath: defaultConfigPath(),
      userConfigPath: configPath,
      homeDir: root,
      systemTimeZone: "UTC",
    });

    const first = await settled(store, T0);
    assert.ok(first.ok);
    assert.equal(first.analysis.data.calls.length, 1);
    assert.equal(first.analysis.data.calls[0]?.inputUncached, 500);
    assert.equal(JSON.stringify(first).includes("PROMPT_SECRET_DO_NOT_LEAK"), false);

    // Append an uncheckpointed WAL write while the writer connection stays open.
    db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "m2",
      "s1",
      "assistant",
      2,
      1793000010000,
      JSON.stringify({
        time: { created: 1793000010000, completed: 1793000011000 },
        model: { id: "model-alpha", providerID: "opencode" },
        tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [],
      }),
    );

    const second = await settled(store, T0 + 60_000);
    assert.ok(second.ok);
    assert.equal(second.analysis.data.calls.length, 2);
    assert.equal(
      second.analysis.data.calls.reduce((sum, c) => sum + (c.inputUncached ?? 0), 0),
      700,
    );
    db.close();
  });

  it("succeeds on a chmod 0555 read-only directory without creating sidecars or changing mtimes (R-15)", async () => {
    const roDir = join(root, "readonly-dir");
    mkdirSync(roDir, { recursive: true });
    const db = createTestDb(roDir);
    db.close();
    const beforeEntries = readdirSync(roDir).sort();
    const beforeMtimes = beforeEntries.map((f) => statSync(join(roDir, f)).mtimeMs);
    chmodSync(roDir, 0o555);

    const lines = await readOpenCodeSqliteLines(join(roDir, "opencode.db"));
    assert.ok(lines.some((l) => l.includes('"record":"session"')));
    assert.ok(lines.some((l) => l.includes('"record":"message"')));

    const afterEntries = readdirSync(roDir).sort();
    const afterMtimes = afterEntries.map((f) => statSync(join(roDir, f)).mtimeMs);
    assert.deepEqual(afterEntries, beforeEntries);
    assert.deepEqual(afterMtimes, beforeMtimes);
  });

  it("emits a diagnostic for non-SQLite or unsupported-schema databases (R-23)", async () => {
    const badDir = join(root, "bad-dir");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "opencode.db"), "not-a-sqlite-db");
    const badLines = await readOpenCodeSqliteLines(join(badDir, "opencode.db"));
    assert.equal(badLines.length, 1);
    assert.equal(JSON.parse(badLines[0] as string).code, "opencode_db_unreadable");

    const emptyDbDir = join(root, "empty-schema-dir");
    mkdirSync(emptyDbDir, { recursive: true });
    const emptyDb = new DatabaseSync(join(emptyDbDir, "opencode.db"));
    emptyDb.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
    emptyDb.close();
    const schemaLines = await readOpenCodeSqliteLines(join(emptyDbDir, "opencode.db"));
    assert.equal(schemaLines.length, 1);
    assert.equal(JSON.parse(schemaLines[0] as string).code, "opencode_schema_unsupported");
  });
});
