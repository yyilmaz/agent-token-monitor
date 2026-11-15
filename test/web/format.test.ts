import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { model, UNKNOWN_GEMINI_MODEL_LABEL, UNKNOWN_GEMINI_MODEL_NOTE } from "../../web/src/format.js";

describe("web format.model (R-16)", () => {
  it("shows unknown gemini model* for Antigravity when model is null or assumed", () => {
    assert.equal(model(null, null, "antigravity"), UNKNOWN_GEMINI_MODEL_LABEL);
    assert.equal(model("gemini-3-pro-high", "assumed", "antigravity"), UNKNOWN_GEMINI_MODEL_LABEL);
    assert.match(UNKNOWN_GEMINI_MODEL_NOTE, /^\* /);
    assert.match(UNKNOWN_GEMINI_MODEL_NOTE, /Antigravity/);
  });

  it("shows a logged model for Antigravity if one is ever recorded", () => {
    assert.equal(model("gemini-3-pro", "logged", "antigravity"), "gemini-3-pro");
  });

  it("keeps unknown model and assumed formatting for other harnesses", () => {
    assert.equal(model(null, null, "claudeCode"), "unknown model");
    assert.equal(model(null, null), "unknown model");
    assert.equal(model("claude-sonnet-4-6", "assumed", "claudeCode"), "claude-sonnet-4-6 (assumed)");
    assert.equal(model("claude-sonnet-4-6", "logged", "claudeCode"), "claude-sonnet-4-6");
  });
});
