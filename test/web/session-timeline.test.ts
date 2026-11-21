// Pins session timeline pagination window behavior (R-72).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { partitionSubagents, timelinePageWindow } from "../../web/src/views/session.js";

describe("timelinePageWindow (R-72)", () => {
  it("shows all rows when total is at or below pageSize", () => {
    assert.deepEqual(timelinePageWindow(0, undefined, 200), { shown: 0, remaining: 0, nextBatch: 0 });
    assert.deepEqual(timelinePageWindow(150, undefined, 200), { shown: 150, remaining: 0, nextBatch: 0 });
    assert.deepEqual(timelinePageWindow(200, undefined, 200), { shown: 200, remaining: 0, nextBatch: 0 });
  });

  it("caps initial view at pageSize and reports remaining older rows", () => {
    assert.deepEqual(timelinePageWindow(800, undefined, 200), { shown: 200, remaining: 600, nextBatch: 200 });
    assert.deepEqual(timelinePageWindow(250, undefined, 200), { shown: 200, remaining: 50, nextBatch: 50 });
  });

  it("expands on Load more and clamps to totalRows", () => {
    assert.deepEqual(timelinePageWindow(800, 400, 200), { shown: 400, remaining: 400, nextBatch: 200 });
    assert.deepEqual(timelinePageWindow(450, 400, 200), { shown: 400, remaining: 50, nextBatch: 50 });
    assert.deepEqual(timelinePageWindow(450, 600, 200), { shown: 450, remaining: 0, nextBatch: 0 });
  });
});

describe("partitionSubagents (LIVE-1)", () => {
  it("keeps active subagents within openWithinSeconds and hides older or call-less ones", () => {
    const asOf = 1_000_000;
    const openWithinSeconds = 300;
    const result = partitionSubagents(
      ["s-new", "s-edge", "s-old", "s-none"],
      {
        "s-new": asOf - 60_000,
        "s-edge": asOf - 300_000,
        "s-old": asOf - 301_000,
        "s-none": null,
      },
      asOf,
      openWithinSeconds,
    );
    assert.deepEqual(result, {
      active: ["s-new", "s-edge"],
      inactive: ["s-old", "s-none"],
    });
  });
});
