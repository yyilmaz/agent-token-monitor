import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildWebviewHtml } from "../../../src/hosts/vscode/webview-html.js";

describe("buildWebviewHtml (R-26, ADR 0021)", () => {
  it("injects strict CSP and rewrites all relative asset URLs in web/static/index.html", () => {
    const indexHtml = readFileSync(fileURLToPath(new URL("../../../../web/static/index.html", import.meta.url)), "utf8");
    const cspSource = "https://file+.vscode-resource.vscode-cdn.net";
    const rewritten = buildWebviewHtml({
      indexHtml,
      cspSource,
      toUri: (rel) => `${cspSource}/ext/${rel}`,
    });

    assert.match(
      rewritten,
      /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net; script-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net; img-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net;" \/>/,
    );
    assert.ok(rewritten.includes(`href="${cspSource}/ext/vendor/bootstrap/bootstrap.min.css"`));
    assert.ok(rewritten.includes(`href="${cspSource}/ext/vendor/uplot/uPlot.min.css"`));
    assert.ok(rewritten.includes(`href="${cspSource}/ext/style.css"`));
    assert.ok(rewritten.includes(`src="${cspSource}/ext/vendor/uplot/uPlot.iife.min.js"`));
    assert.ok(rewritten.includes(`src="${cspSource}/ext/vendor/bootstrap/js/drawer.js"`));
    assert.ok(rewritten.includes(`src="${cspSource}/ext/js/main.js"`));
    assert.doesNotMatch(rewritten, /\b(href|src)="(?!https:\/\/)/);
  });
});
