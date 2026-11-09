// Pins ADR 0014: for every adapter, combining per-file results equals parsing all files at once, byte for byte,
// in any order, and file results survive a JSON round trip (they are plain data, like the model).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ANTIGRAVITY_FILE_PATTERN, combineAntigravity, parseAntigravity, readAntigravityFile } from "../../../src/core/adapters/antigravity/index.js";
import { CLAUDE_CODE_FILE_PATTERN, combineClaudeCode, parseClaudeCode, readClaudeCodeFile } from "../../../src/core/adapters/claude-code/index.js";
import type { LogFile } from "../../../src/core/host/index.js";
import type { AdapterOutput } from "../../../src/core/model/index.js";
import { FsLogSource, readLogFiles } from "../../../src/hosts/node/log-source.js";

interface Case {
  readonly name: string;
  readonly root: string;
  readonly logRoot: string;
  readonly pattern: RegExp;
  readonly parse: (files: readonly LogFile[]) => AdapterOutput;
  readonly read: (file: LogFile) => unknown;
  readonly combine: (results: readonly never[]) => AdapterOutput;
}

const CASES: readonly Case[] = [
  {
    name: "Claude Code",
    root: fileURLToPath(new URL("../../../../test/fixtures/claude-code/projects", import.meta.url)),
    logRoot: "claudeCode:0",
    pattern: CLAUDE_CODE_FILE_PATTERN,
    parse: parseClaudeCode,
    read: readClaudeCodeFile,
    combine: combineClaudeCode as (results: readonly never[]) => AdapterOutput,
  },
  {
    name: "Antigravity",
    root: fileURLToPath(new URL("../../../../test/fixtures/antigravity/brain", import.meta.url)),
    logRoot: "antigravity:0",
    pattern: ANTIGRAVITY_FILE_PATTERN,
    parse: parseAntigravity,
    read: readAntigravityFile,
    combine: combineAntigravity as (results: readonly never[]) => AdapterOutput,
  },
];

for (const c of CASES) {
  describe(`${c.name}: readFile + combine (ADR 0014)`, () => {
    const load = () => readLogFiles(new FsLogSource({ [c.logRoot]: c.root }), [c.logRoot], c.pattern);

    it("equals parsing all files at once, in any order of file results", async () => {
      const files = await load();
      assert.ok(files.length > 1, "fixtures need several files");
      const expected = JSON.stringify(c.parse(files));
      const results = files.map(c.read);
      assert.equal(JSON.stringify(c.combine(results as never[])), expected);
      assert.equal(JSON.stringify(c.combine([...results].reverse() as never[])), expected);
    });

    it("keeps file results as plain JSON-safe data", async () => {
      const files = await load();
      const results = files.map(c.read);
      const roundTripped = JSON.parse(JSON.stringify(results)) as never[];
      assert.equal(JSON.stringify(c.combine(roundTripped)), JSON.stringify(c.parse(files)));
    });
  });
}
