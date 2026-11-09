// Pins configuration validation and merge behavior (ADR 0007, R-72, R-10, R-13).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CONFIG_SCHEMA_VERSION, loadConfig, mergeConfig, stableStringify } from "../../src/core/config/config.js";

const DEFAULTS_PATH = fileURLToPath(new URL("../../../config/default.json", import.meta.url));
const defaultsText = readFileSync(DEFAULTS_PATH, "utf8");
const defaults = { path: "config/default.json", text: defaultsText };

function withUser(user: unknown) {
  return loadConfig({ defaults, user: { path: "user.json", text: JSON.stringify(user) } });
}

function errorsOf(result: ReturnType<typeof loadConfig>) {
  assert.equal(result.ok, false, "expected the configuration to be rejected");
  return result.ok ? [] : result.errors;
}

describe("shipped defaults (R-72)", () => {
  it("are complete and valid on their own", () => {
    const result = loadConfig({ defaults, user: null });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("use the current schema version", () => {
    assert.equal(JSON.parse(defaultsText).schemaVersion, CONFIG_SCHEMA_VERSION);
  });
});

describe("user override (ADR 0007)", () => {
  it("overrides a single scalar and keeps every other default", () => {
    const result = withUser({ cache: { hitToleranceTokens: 0 } });
    assert.ok(result.ok);
    const base = loadConfig({ defaults, user: null });
    assert.ok(base.ok);
    assert.equal(result.config.cache.hitToleranceTokens, 0);
    assert.equal(result.config.cache.fullMissMinContextTokens, base.config.cache.fullMissMinContextTokens);
    assert.deepEqual(result.config.logRoots, base.config.logRoots);
  });

  it("replaces arrays as a whole instead of merging them", () => {
    const result = withUser({ logRoots: { claudeCode: ["/custom/claude"] } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.logRoots.claudeCode, ["/custom/claude"]);
  });

  it("merges free-form records key by key", () => {
    const result = withUser({ cache: { declaredLifetimeSeconds: { claudeCode: { "model-a": 3600 } } } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.cache.declaredLifetimeSeconds.claudeCode, { "model-a": 3600 });
    assert.deepEqual(result.config.cache.declaredLifetimeSeconds.codex, {});
  });

  it("accepts an assumed model per harness (ADR 0009 MODEL-1)", () => {
    const result = withUser({ models: { assumed: { antigravity: "model-g" } } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.models.assumed, { antigravity: "model-g" });
  });

  it("accepts an empty object", () => {
    assert.equal(withUser({}).ok, true);
  });
});

describe("validation errors", () => {
  it("rejects an unknown key with its path and file, so typos never fall back to defaults", () => {
    assert.deepEqual(errorsOf(withUser({ cache: { hitTolerance: 5 } })), [
      { file: "user.json", path: "cache.hitTolerance", message: "unknown key" },
    ]);
  });

  it("rejects an assumed model for anything but a harness ID", () => {
    assert.deepEqual(errorsOf(withUser({ models: { assumed: { antigravty: "model-g" } } })), [
      {
        file: "user.json",
        path: "models.assumed.antigravty",
        message: "unknown key; allowed: claudeCode, antigravity, codex, opencode",
      },
    ]);
  });

  it("rejects session advice context band edges that are not strictly ascending (ADR 0017)", () => {
    assert.deepEqual(errorsOf(withUser({ rules: { sessionAdvice: { contextBandEdgesTokens: [100000, 50000] } } })), [
      { file: "user.json", path: "rules.sessionAdvice.contextBandEdgesTokens[1]", message: "values must be strictly ascending" },
    ]);
  });

  it("rejects Usage summary ranges that are empty or not strictly ascending (R-33)", () => {
    assert.deepEqual(errorsOf(withUser({ ui: { usageRangesDays: [30, 7] } })), [
      { file: "user.json", path: "ui.usageRangesDays[1]", message: "values must be strictly ascending" },
    ]);
    assert.equal(errorsOf(withUser({ ui: { usageRangesDays: [] } }))[0]?.path, "ui.usageRangesDays");
  });

  it("rejects removed pricing and identifies the current schema version (R-51, ADR 0007)", () => {
    assert.deepEqual(errorsOf(withUser({ pricing: {} })), [
      { file: "user.json", path: "pricing", message: "unknown key" },
    ]);
    assert.match(errorsOf(withUser({ schemaVersion: 1 }))[0]?.message ?? "", /expected schemaVersion 2/);
    assert.ok(withUser({ schemaVersion: 2, usage: { timeZone: "UTC" } }).ok);
  });

  it("rejects token weights beyond six decimal places (ADR 0017)", () => {
    const [error] = errorsOf(withUser({ rules: { sessionAdvice: { weights: { cacheRead: 0.0000001 } } } }));
    assert.equal(error?.path, "rules.sessionAdvice.weights.cacheRead");
    assert.match(error?.message ?? "", /at most 6 decimal places/);
  });

  it("rejects null", () => {
    assert.deepEqual(errorsOf(withUser({ ui: { pollIntervalSeconds: null } })), [
      { file: "user.json", path: "ui.pollIntervalSeconds", message: "null is not allowed" },
    ]);
  });

  it("rejects a non-integer where an integer is required", () => {
    const [error] = errorsOf(withUser({ cache: { minLifetimeObservations: 2.5 } }));
    assert.equal(error?.path, "cache.minLifetimeObservations");
  });

  it("rejects a rate outside 0..1", () => {
    const [error] = errorsOf(withUser({ cache: { survivedMinCacheReadShare: 1.5 } }));
    assert.equal(error?.path, "cache.survivedMinCacheReadShare");
  });

  it("rejects band edges that are not strictly ascending", () => {
    const [error] = errorsOf(withUser({ cache: { lifetimeBandEdgesSeconds: [60, 60, 300] } }));
    assert.equal(error?.path, "cache.lifetimeBandEdgesSeconds[1]");
  });

  it("rejects a wrong schema version without migrating it", () => {
    const [error] = errorsOf(withUser({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 }));
    assert.equal(error?.path, "schemaVersion");
  });

  it("rejects invalid JSON", () => {
    const result = loadConfig({ defaults, user: { path: "user.json", text: "{ \"ui\": " } });
    const [error] = errorsOf(result);
    assert.equal(error?.file, "user.json");
    assert.match(error?.message ?? "", /^not valid JSON/);
  });

  it("has no place for credentials: any extra top-level key is rejected (R-13)", () => {
    const [error] = errorsOf(withUser({ apiKey: "placeholder" }));
    assert.deepEqual(error, { file: "user.json", path: "apiKey", message: "unknown key" });
  });

  it("reports a missing required key when the defaults are incomplete", () => {
    const broken = JSON.parse(defaultsText);
    delete broken.ui;
    const result = loadConfig({ defaults: { path: "default.json", text: JSON.stringify(broken) }, user: null });
    assert.deepEqual(errorsOf(result), [{ file: "default.json", path: "ui", message: "missing required key" }]);
  });
});

describe("mergeConfig", () => {
  it("does not modify its inputs", () => {
    const base = { a: { b: 1, c: 2 } };
    const override = { a: { b: 3 } };
    assert.deepEqual(mergeConfig(base, override), { a: { b: 3, c: 2 } });
    assert.deepEqual(base, { a: { b: 1, c: 2 } });
  });
});

describe("stableStringify (R-10, R-71)", () => {
  it("produces identical bytes regardless of key order", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [2, 1], c: 0 } }), stableStringify({ a: { c: 0, d: [2, 1] }, b: 1 }));
  });

  it("keeps array order", () => {
    assert.equal(stableStringify([2, 1]), "[\n  2,\n  1\n]");
  });
});
