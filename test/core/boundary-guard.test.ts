// src/core must stay host-independent and deterministic (ADR 0006, R-10, R-11, R-25, R-26).
// It may import only relative paths inside src/core, and may not touch host globals, the clock or randomness.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const CORE_DIR = fileURLToPath(new URL("../../../src/core", import.meta.url));

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "Date.now", pattern: /\bDate\.now\b/ },
  { name: "argument-less new Date()", pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { name: "performance.now", pattern: /\bperformance\.now\b/ },
  { name: "Math.random", pattern: /\bMath\.random\b/ },
  { name: "crypto random functions", pattern: /\b(randomUUID|getRandomValues|randomBytes)\b/ },
  { name: "host global", pattern: /\b(process|require|window|document|fetch)\s*[.(]/ },
];

const IMPORT = /\b(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

/** Drops comment text so words like "document." in prose do not count. */
function codeOnly(line: string): string {
  if (/^\s*(\/\*|\*)/.test(line)) return "";
  const comment = line.indexOf("//");
  return comment === -1 ? line : line.slice(0, comment);
}

function violationsIn(file: string): string[] {
  const where = relative(CORE_DIR, file);
  const found: string[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = codeOnly(raw);
      const at = `${where}:${index + 1}`;
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${at} uses ${name}`);
      }
      const match = IMPORT.exec(line);
      const specifier = match?.[1] ?? match?.[2] ?? match?.[3];
      if (specifier === undefined) return;
      const insideCore =
        specifier.startsWith(".") && !relative(CORE_DIR, resolve(dirname(file), specifier)).startsWith("..");
      if (!insideCore) found.push(`${at} imports "${specifier}" from outside src/core`);
    });
  return found;
}

it("src/core imports only from src/core and uses no host globals, clock or randomness", () => {
  const files = sourceFiles(CORE_DIR);
  assert.ok(files.length > 0, "no core sources found");
  assert.deepEqual(files.flatMap(violationsIn), []);
});

const WEB_DIR = fileURLToPath(new URL("../../../web/src", import.meta.url));

it("the frontend imports only types from src/core (ADR 0002, ADR 0006)", () => {
  const found = sourceFiles(WEB_DIR).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const match = IMPORT.exec(codeOnly(line));
        const specifier = match?.[1] ?? match?.[2] ?? match?.[3];
        if (specifier === undefined || !resolve(dirname(file), specifier).startsWith(resolve(CORE_DIR, ".."))) return [];
        return /^\s*import\s+type\b/.test(line) ? [] : [`${relative(WEB_DIR, file)}:${index + 1} imports runtime code from src`];
      }),
  );
  assert.deepEqual(found, []);
});
