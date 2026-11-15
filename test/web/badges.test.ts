import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harnessBadgeSpec, modelBadgeSpec } from "../../web/src/badges.js";

describe("web badges (ADR 0020, R-20)", () => {
  it("maps each supported harness to its monogram and series color class", () => {
    assert.deepEqual(harnessBadgeSpec("claudeCode"), { code: "CC", seriesClass: "badge-series-1" });
    assert.deepEqual(harnessBadgeSpec("antigravity"), { code: "AG", seriesClass: "badge-series-2" });
    assert.deepEqual(harnessBadgeSpec("codex"), { code: "CX", seriesClass: "badge-series-3" });
    assert.deepEqual(harnessBadgeSpec("opencode"), { code: "OC", seriesClass: "badge-series-4" });
  });

  it("falls back deterministically for unknown or null harnesses", () => {
    assert.deepEqual(harnessBadgeSpec("windsurf"), { code: "WI", seriesClass: "badge-series-neutral" });
    assert.deepEqual(harnessBadgeSpec(null), { code: "--", seriesClass: "badge-series-neutral" });
    assert.deepEqual(harnessBadgeSpec("---"), { code: "--", seriesClass: "badge-series-neutral" });
  });

  it("maps known model families deterministically", () => {
    assert.deepEqual(modelBadgeSpec("claude-sonnet-4-6", "logged", "claudeCode"), { code: "CL", family: "claude" });
    assert.deepEqual(modelBadgeSpec("anthropic/claude-opus-4-1", "logged", "opencode"), { code: "CL", family: "claude" });
    assert.deepEqual(modelBadgeSpec("gpt-5", "logged", "codex"), { code: "GP", family: "openai" });
    assert.deepEqual(modelBadgeSpec("o3-mini", "logged", "codex"), { code: "GP", family: "openai" });
    assert.deepEqual(modelBadgeSpec("gemini-2.5-pro", "logged", "antigravity"), { code: "GM", family: "gemini" });
    assert.deepEqual(modelBadgeSpec("deepseek-r1", "logged", "opencode"), { code: "DS", family: "deepseek" });
    assert.deepEqual(modelBadgeSpec("qwen-2.5-coder", "logged", "opencode"), { code: "QW", family: "qwen" });
  });

  it("maps Antigravity unknown/assumed models to Gemini and unknown models to ??", () => {
    assert.deepEqual(modelBadgeSpec(null, null, "antigravity"), { code: "GM", family: "gemini" });
    assert.deepEqual(modelBadgeSpec("gemini-3-pro-high", "assumed", "antigravity"), { code: "GM", family: "gemini" });
    assert.deepEqual(modelBadgeSpec(null, null, "claudeCode"), { code: "??", family: "unknown" });
    assert.deepEqual(modelBadgeSpec("custom-model", "logged", "opencode"), { code: "CU", family: "other" });
  });
});
