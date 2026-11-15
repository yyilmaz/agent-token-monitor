// Pins self-contained HTML report assembly (R-10, R-14, R-71, ADR 0023).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { analyze } from "../../src/core/api/index.js";
import { buildHtmlReport, buildReportData, type ReportAssets, type ReportData } from "../../src/core/api/report.js";
import { loadConfig, type Config } from "../../src/core/config/config.js";
import type { AdapterOutput, Session } from "../../src/core/model/index.js";

const DEFAULTS_PATH = fileURLToPath(new URL("../../../config/default.json", import.meta.url));
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

function defaultConfig(): Config {
  const loaded = loadConfig({ defaults: { path: DEFAULTS_PATH, text: readFileSync(DEFAULTS_PATH, "utf8") }, user: null });
  assert.ok(loaded.ok);
  return loaded.config;
}

function makeSession(id: string, title: string, projectPath: string): Session {
  return {
    id,
    harness: "claudeCode",
    nativeId: id,
    parentSessionId: null,
    isSubagent: false,
    spawnedBySessionId: null,
    title,
    projectPath,
    sources: [{ logRoot: "r:0", file: `${id}.jsonl`, line: 1 }],
  };
}

function makeOutput(sessions: readonly Session[]): AdapterOutput {
  return {
    sessions,
    calls: sessions.map((s) => ({
      id: `call-${s.id}`,
      sessionId: s.id,
      timestamp: NOW - 10_000,
      model: "claude-sonnet-4-5",
      kind: "turn",
      inputUncached: 100,
      cacheRead: 200,
      cacheWrite: 0,
      output: 50,
      reasoning: null,
      cacheWriteByTtlSeconds: null,
      toolNames: ["Read"],
      shellClasses: [],
      sources: [{ logRoot: "r:0", file: `${s.id}.jsonl`, line: 1 }],
    })),
    events: [],
    quotaSamples: [],
    diagnostics: [],
  };
}

const SAMPLE_ASSETS: ReportAssets = {
  indexHtml: [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <link rel="stylesheet" href="vendor/bootstrap/bootstrap.min.css" />',
    '    <link rel="stylesheet" href="style.css" />',
    '    <script src="vendor/uplot/uPlot.iife.min.js"></script>',
    '    <script type="module" src="js/main.js"></script>',
    "  </head>",
    "  <body>",
    '    <main id="view"></main>',
    "  </body>",
    "</html>",
  ].join("\n"),
  stylesheets: ["body { color: #111; }", ".card { padding: 8px; }"],
  classicScripts: ["window.uPlot = function() {};"],
  modules: {
    "js/main.js": [
      'import { greet } from "./helper.js";',
      'import * as fmt from "./format.js";',
      'import Def from "./default.js";',
      "globalThis.__reportBooted = greet(fmt.label, Def);",
      "//# sourceMappingURL=main.js.map",
    ].join("\n"),
    "js/helper.js": 'export function greet(a, b) { return `${a}:${b}`; }\n',
    "js/format.js": 'const label = "ok";\nexport { label };\n',
    "js/default.js": 'const value = 42;\nexport { value as default };\n',
  },
  entryModules: ["js/main.js"],
};

describe("HTML report builder (R-10, R-14, R-71, ADR 0023)", () => {
  it("produces byte-identical HTML regardless of input session ordering", () => {
    const config = defaultConfig();
    const s1 = makeSession("s-1", "Alpha </script> title", "/Users/dev/project-alpha");
    const s2 = makeSession("s-2", "Beta title", "/Users/dev/project-beta");

    const a1 = analyze(makeOutput([s1, s2]), config, "UTC");
    const a2 = analyze(makeOutput([s2, s1]), config, "UTC");

    const html1 = buildHtmlReport(buildReportData(a1, NOW), SAMPLE_ASSETS);
    const html2 = buildHtmlReport(buildReportData(a2, NOW), SAMPLE_ASSETS);

    assert.equal(html1, html2);
  });

  it("embeds configuration, all views, and all sessions as valid JSON with </script> escaped", () => {
    const config = defaultConfig();
    const s1 = makeSession("s-1", "Fix </script> bug", "/Users/dev/my-repo");
    const analysis = analyze(makeOutput([s1]), config, "Europe/Istanbul");
    const html = buildHtmlReport(buildReportData(analysis, NOW), SAMPLE_ASSETS);

    const match = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, "expected #report-data script element");
    assert.doesNotMatch(match[1] as string, /<\/script/i);

    const parsed = JSON.parse(match[1] as string) as ReportData;
    assert.equal(parsed.asOf, NOW);
    assert.equal(parsed.timeZone, "Europe/Istanbul");
    assert.deepEqual(parsed.configuration, config);
    assert.ok(parsed.sessions["s-1"]);
    assert.equal(parsed.sessions["s-1"]?.session.title, "Fix </script> bug");
    assert.equal(parsed.sessions["s-1"]?.session.projectPath, "/Users/dev/my-repo");
  });

  it("strips external script tags whose end tag has whitespace or attributes (R-14, R-71)", () => {
    const analysis = analyze(makeOutput([makeSession("s-1", "One", "/repo")]), defaultConfig(), "UTC");
    const assets: ReportAssets = {
      ...SAMPLE_ASSETS,
      indexHtml: SAMPLE_ASSETS.indexHtml.replace('src="js/main.js"></script>', 'src="js/main.js"></script foo="bar">'),
    };
    const html = buildHtmlReport(buildReportData(analysis, NOW), assets);
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
  });

  it("inlines all styles/scripts with no external links and valid bundled JS", () => {
    const analysis = analyze(makeOutput([makeSession("s-1", "One", "/repo")]), defaultConfig(), "UTC");
    const html = buildHtmlReport(buildReportData(analysis, NOW), SAMPLE_ASSETS);

    assert.doesNotMatch(html, /<link\s+rel="stylesheet"/i);
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
    assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
    assert.match(html, /<style>[\s\S]*body \{ color: #111; \}[\s\S]*<\/style>/);

    const scriptMatch = /<script>\n([\s\S]*?)\n<\/script>\s*<\/body>/.exec(html);
    assert.ok(scriptMatch, "expected inline script before </body>");
    const sandbox: Record<string, unknown> = { window: {}, globalThis: {} };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(scriptMatch[1] as string, sandbox);
    assert.equal(sandbox.__reportBooted, "ok:42");
  });
});
