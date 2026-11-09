// Pins the in-memory file cache of ADR 0014: after files change or disappear, the store's result equals that of a
// fresh store reading everything. Works on a copy of the fixtures in a temporary directory (R-15).

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { defaultConfigPath } from "../../../src/hosts/node/config.js";
import { AnalysisStore, type StoreState } from "../../../src/hosts/node/store.js";

const FIXTURES = fileURLToPath(new URL("../../../../test/fixtures", import.meta.url));
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const STEP = 60_000;

const dir = mkdtempSync(join(tmpdir(), "atm-store-"));
cpSync(FIXTURES, join(dir, "logs"), { recursive: true });
const userConfigPath = join(dir, "config.json");
writeFileSync(
  userConfigPath,
  JSON.stringify({
    logRoots: {
      claudeCode: [join(dir, "logs", "claude-code", "projects")],
      antigravity: [join(dir, "logs", "antigravity", "brain")],
      codex: [],
    },
  }),
);

const newStore = () => new AnalysisStore({ defaultsPath: defaultConfigPath(), userConfigPath, homeDir: dir, systemTimeZone: "UTC" });

async function settled(store: AnalysisStore, now: number): Promise<StoreState> {
  await store.current(now);
  await store.idle();
  return store.current(now);
}

const data = (state: StoreState) => {
  assert.ok(state.ok);
  return JSON.stringify(state.analysis.data);
};

describe("file cache (ADR 0014)", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const store = newStore();

  it("matches a fresh store after a file changes", async () => {
    const first = data(await settled(store, T0));
    const file = join(dir, "logs", "claude-code", "projects", "-fixture-project", "session-a.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, lines.slice(0, -1).join("\n") + "\n");
    const changed = data(await settled(store, T0 + STEP));
    assert.notEqual(changed, first);
    assert.equal(changed, data(await settled(newStore(), T0 + STEP)));
  });

  it("matches a fresh store after a file disappears", async () => {
    unlinkSync(join(dir, "logs", "claude-code", "projects", "-fixture-project", "session-b.jsonl"));
    const removed = data(await settled(store, T0 + 2 * STEP));
    assert.equal(removed, data(await settled(newStore(), T0 + 2 * STEP)));
    assert.ok(!removed.includes("session-b.jsonl"));
  });

  it("answers from the previous result while a check runs in the background", async () => {
    const before = await store.current(T0 + 2 * STEP);
    const during = store.current(T0 + 3 * STEP);
    assert.equal(await during, before);
    await store.idle();
  });
});

describe("harness sources (R-20, R-21, R-23)", () => {
  const root = mkdtempSync(join(tmpdir(), "atm-sources-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(FIXTURES, join(root, "logs"), { recursive: true });
  // Stand-ins for harnesses without an adapter: only their file names matter, the contents are never read.
  mkdirSync(join(root, "codex", "2026", "10", "31"), { recursive: true });
  writeFileSync(join(root, "codex", "2026", "10", "31", "rollout-a.jsonl"), "not read\n");
  writeFileSync(join(root, "codex", "notes.txt"), "not a session\n");
  mkdirSync(join(root, "opencode"), { recursive: true });
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      logRoots: {
        claudeCode: [join(root, "logs", "claude-code", "projects")],
        antigravity: [],
        codex: [join(root, "codex")],
        opencode: [join(root, "opencode")],
      },
    }),
  );

  it("reports read harnesses, found-but-unread ones by their session files, and nothing for empty roots", async () => {
    const store = new AnalysisStore({ defaultsPath: defaultConfigPath(), userConfigPath: config, homeDir: root, systemTimeZone: "UTC" });
    const state = await settled(store, T0);
    assert.ok(state.ok);
    const sources = state.analysis.sources.map((s) => [s.harness, s.read, s.files > 0 ? "found" : "none"]);
    assert.deepEqual(sources, [
      ["claudeCode", true, "found"],
      ["antigravity", true, "none"],
      ["codex", false, "found"],
      ["opencode", false, "none"],
    ]);
    assert.equal(state.analysis.sources.find((s) => s.harness === "codex")?.files, 1);
  });
});
