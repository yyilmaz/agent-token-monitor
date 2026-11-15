// Self-contained HTML report builder (R-10, R-14, R-18, R-25, R-26, R-71, ADR 0023).
// Pure functions in src/core: hosts read the static/script/vendor files and pass them in.

import { stableStringify, type Config } from "../config/config.js";
import type { EpochMillis } from "../model/index.js";
import { compareStrings } from "../order.js";
import { cache, diagnostics, overview, session, usage, type Analysis } from "./index.js";

export interface ReportData {
  readonly asOf: EpochMillis;
  readonly timeZone: string;
  readonly configuration: Config;
  readonly overview: ReturnType<typeof overview>;
  readonly usageByDay: ReturnType<typeof usage>;
  readonly cache: ReturnType<typeof cache>;
  readonly diagnostics: ReturnType<typeof diagnostics>;
  readonly sessions: Readonly<Record<string, NonNullable<ReturnType<typeof session>>>>;
}

export interface ReportAssets {
  /** Raw contents of web/static/index.html. */
  readonly indexHtml: string;
  /** Stylesheets in document order (e.g. bootstrap.min.css, uPlot.min.css, style.css). */
  readonly stylesheets: readonly string[];
  /** Classic (non-module) vendor scripts inlined before modules (e.g. uPlot.iife.min.js). */
  readonly classicScripts: readonly string[];
  /** Compiled ES modules keyed by web-root-relative path (e.g. "js/main.js", "vendor/bootstrap/js/drawer.js"). */
  readonly modules: Readonly<Record<string, string>>;
  /** Entry modules executed in order once the DOM is ready. */
  readonly entryModules: readonly string[];
}

export const REPORT_FILENAME = "agent-token-monitor-report.html";

/** Builds the deterministic snapshot payload embedded in an exported HTML report (R-10, R-71, ADR 0023). */
export function buildReportData(analysis: Analysis, asOf: EpochMillis): ReportData {
  const sessions: Record<string, NonNullable<ReturnType<typeof session>>> = {};
  const ids = analysis.data.sessions.map((s) => s.id).sort(compareStrings);
  for (const id of ids) {
    const detail = session(analysis, asOf, id);
    if (detail !== null) sessions[id] = detail;
  }
  return {
    asOf,
    timeZone: analysis.timeZone,
    configuration: analysis.config,
    overview: overview(analysis, asOf),
    usageByDay: usage(analysis, asOf, "day"),
    cache: cache(analysis, asOf),
    diagnostics: diagnostics(analysis, asOf),
    sessions,
  };
}

/** Assembles one self-contained, offline, deterministic HTML report (R-10, R-14, R-71, ADR 0023). */
export function buildHtmlReport(report: ReportData, assets: ReportAssets): string {
  const cspMeta =
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\';" />';
  const styles = `<style>\n${assets.stylesheets.join("\n")}\n</style>`;
  const json = stableStringify(report).replace(/</g, "\\u003c");
  const dataScript = `<script type="application/json" id="report-data">${json}</script>`;
  const bundle = bundleModules(assets.entryModules, assets.modules);
  const inlineScript = `<script>\n${[...assets.classicScripts, bundle].join("\n")}\n</script>`;

  // Strip external stylesheet links and script tags from the template; inline replacements take their place.
  const withoutExternals = assets.indexHtml
    .replace(/^[ \t]*<link\s+rel="stylesheet"\s+href="[^"]+"\s*\/>\r?\n?/gm, "")
    // One external script element per line (web/static/index.html); drop the whole line instead of matching its end tag.
    .replace(/^[ \t]*<script\b[^\n]*\ssrc="[^"]+"[^\n]*$\r?\n?/gm, "");

  const withHead = withoutExternals.replace("</head>", `${cspMeta}\n${styles}\n  </head>`);
  return withHead.replace("</body>", `    ${dataScript}\n    ${inlineScript}\n  </body>`);
}

const IMPORT_FROM = /^import\s+(.+?)\s+from\s+["']([^"']+)["'];?$/;
const IMPORT_SIDE_EFFECT = /^import\s+["']([^"']+)["'];?$/;
const EXPORT_DECL = /^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/;
const EXPORT_LIST = /^export\s*\{([^}]+)\};?$/;

function resolveModulePath(fromPath: string, specifier: string): string {
  const base = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

function parseImportSpecifiers(modulePath: string, source: string): string[] {
  const deps: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fromMatch = IMPORT_FROM.exec(line);
    if (fromMatch !== null) {
      deps.push(resolveModulePath(modulePath, fromMatch[2] as string));
      continue;
    }
    const sideMatch = IMPORT_SIDE_EFFECT.exec(line);
    if (sideMatch !== null) {
      deps.push(resolveModulePath(modulePath, sideMatch[1] as string));
    }
  }
  return deps;
}

function topologicalOrder(entryModules: readonly string[], modules: Readonly<Record<string, string>>): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(path: string): void {
    if (visited.has(path)) return;
    if (visiting.has(path)) return;
    const source = modules[path];
    if (source === undefined) throw new Error(`missing report module: ${path}`);
    visiting.add(path);
    for (const dep of parseImportSpecifiers(path, source)) visit(dep);
    visiting.delete(path);
    visited.add(path);
    order.push(path);
  }

  for (const entry of entryModules) visit(entry);
  return order;
}

function rewriteEsModule(modulePath: string, source: string): string {
  const exportedDecls: string[] = [];
  const lines: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.startsWith("//# sourceMappingURL=")) continue;
    const trimmed = rawLine.trim();

    const fromMatch = IMPORT_FROM.exec(trimmed);
    if (fromMatch !== null) {
      const clause = (fromMatch[1] as string).trim();
      const target = resolveModulePath(modulePath, fromMatch[2] as string);
      const req = `__require(${JSON.stringify(target)})`;
      if (clause.startsWith("{")) {
        const mapped = clause.replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g, "$1: $2");
        lines.push(`const ${mapped} = ${req};`);
      } else if (clause.startsWith("* as ")) {
        const ns = clause.slice("* as ".length).trim();
        lines.push(`const ${ns} = ${req};`);
      } else {
        lines.push(`const ${clause} = ${req}.default;`);
      }
      continue;
    }

    const sideMatch = IMPORT_SIDE_EFFECT.exec(trimmed);
    if (sideMatch !== null) {
      const target = resolveModulePath(modulePath, sideMatch[1] as string);
      lines.push(`__require(${JSON.stringify(target)});`);
      continue;
    }

    const declMatch = EXPORT_DECL.exec(rawLine);
    if (declMatch !== null) {
      const kind = declMatch[1] as string;
      const name = declMatch[2] as string;
      const rest = declMatch[3] as string;
      exportedDecls.push(name);
      lines.push(`${kind} ${name}${rest}`);
      continue;
    }

    const listMatch = EXPORT_LIST.exec(trimmed);
    if (listMatch !== null) {
      const items = (listMatch[1] as string).split(",").map((s) => s.trim()).filter(Boolean);
      const assignments = items.map((item) => {
        const asParts = item.split(/\s+as\s+/);
        const local = (asParts[0] as string).trim();
        const exported = (asParts[1] ?? local).trim();
        return `__exports[${JSON.stringify(exported)}] = ${local};`;
      });
      lines.push(assignments.join(" "));
      continue;
    }

    lines.push(rawLine);
  }

  for (const name of exportedDecls) {
    lines.push(`__exports[${JSON.stringify(name)}] = ${name};`);
  }
  return lines.join("\n");
}

function bundleModules(entryModules: readonly string[], modules: Readonly<Record<string, string>>): string {
  const ordered = topologicalOrder(entryModules, modules);
  const registrations = ordered.map((path) => {
    const body = rewriteEsModule(path, modules[path] as string);
    return `__modules[${JSON.stringify(path)}] = function(__exports, __require) {\n${body}\n};`;
  });
  const entries = entryModules.map((entry) => `__require(${JSON.stringify(entry)});`).join("\n");

  return [
    "(function() {",
    "const __modules = Object.create(null);",
    "const __cache = Object.create(null);",
    "function __require(id) {",
    "  if (__cache[id]) return __cache[id].exports;",
    "  const mod = { exports: {} };",
    "  __cache[id] = mod;",
    "  __modules[id](mod.exports, __require);",
    "  return mod.exports;",
    "}",
    ...registrations,
    entries,
    "})();",
  ].join("\n");
}
