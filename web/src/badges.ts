// Self-authored inline SVG monogram badges for harnesses and model families (ADR 0020, R-14, R-26).

import { h, svg } from "./dom.js";
import * as f from "./format.js";

export interface HarnessBadgeSpec {
  readonly code: string;
  readonly seriesClass: string;
}

export interface ModelBadgeSpec {
  readonly code: string;
  readonly family: string;
}

const HARNESS_BADGES: Readonly<Record<string, HarnessBadgeSpec>> = {
  claudeCode: { code: "CC", seriesClass: "badge-series-1" },
  antigravity: { code: "AG", seriesClass: "badge-series-2" },
  codex: { code: "CX", seriesClass: "badge-series-3" },
  opencode: { code: "OC", seriesClass: "badge-series-4" },
};

function fallbackCode(value: string | null, empty = "--"): string {
  if (value === null) return empty;
  const alnum = value.replace(/[^a-zA-Z0-9]/g, "");
  if (alnum.length === 0) return empty;
  return alnum.slice(0, 2).toUpperCase();
}

export function harnessBadgeSpec(id: string | null): HarnessBadgeSpec {
  if (id !== null) {
    const known = HARNESS_BADGES[id];
    if (known !== undefined) return known;
  }
  return { code: fallbackCode(id), seriesClass: "badge-series-neutral" };
}

export function modelBadgeSpec(name: string | null, source: string | null, harness?: string | null): ModelBadgeSpec {
  if (harness === "antigravity" && (name === null || source === "assumed")) {
    return { code: "GM", family: "gemini" };
  }
  if (name === null) return { code: "??", family: "unknown" };
  const stripped = name.includes("/") ? (name.split("/").at(-1) as string) : name;
  const lower = stripped.toLowerCase();
  if (lower.includes("claude")) return { code: "CL", family: "claude" };
  if (lower.includes("gemini")) return { code: "GM", family: "gemini" };
  if (/^(?:gpt|o[1-9]|codex)/.test(lower)) return { code: "GP", family: "openai" };
  if (lower.includes("deepseek")) return { code: "DS", family: "deepseek" };
  if (lower.includes("qwen")) return { code: "QW", family: "qwen" };
  if (lower.includes("llama")) return { code: "LL", family: "llama" };
  if (lower.includes("mistral")) return { code: "MS", family: "mistral" };
  return { code: fallbackCode(stripped, "??"), family: "other" };
}

export function harnessBadge(id: string | null): SVGSVGElement {
  const spec = harnessBadgeSpec(id);
  return svg(
    "svg",
    {
      class: `entity-badge harness-badge ${spec.seriesClass}`,
      viewBox: "0 0 18 18",
      width: 16,
      height: 16,
      "aria-hidden": "true",
    },
    svg("rect", { x: 1, y: 1, width: 16, height: 16, rx: 4 }),
    svg("text", { x: 9, y: 11.8, "text-anchor": "middle" }, spec.code),
  );
}

export function modelBadge(name: string | null, source: string | null, harness?: string | null): SVGSVGElement {
  const spec = modelBadgeSpec(name, source, harness);
  return svg(
    "svg",
    {
      class: `entity-badge model-badge model-family-${spec.family}`,
      viewBox: "0 0 20 16",
      width: 18,
      height: 14,
      "aria-hidden": "true",
    },
    svg("rect", { x: 0.75, y: 0.75, width: 18.5, height: 14.5, rx: 7.25 }),
    svg("text", { x: 10, y: 10.6, "text-anchor": "middle" }, spec.code),
  );
}

export function harnessLabel(id: string | null): HTMLElement {
  return h("span", { class: "badge-label" }, harnessBadge(id), h("span", {}, f.harness(id)));
}

export function modelLabel(name: string | null, source: string | null, harness?: string | null): HTMLElement {
  return h("span", { class: "badge-label" }, modelBadge(name, source, harness), h("span", {}, f.model(name, source, harness)));
}
