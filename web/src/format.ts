// Display formatting only.

import type { DeclaredGroup, MissCauseKind } from "../../src/core/analysis/cache.js";

/** Groups digits with thin spaces; independent of the browser locale. */
export function tokens(value: number | null): string {
  if (value === null) return "unknown";
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 152 474 → "152.5K", 70 000 000 → "70M": short enough to read at a glance; the exact value goes in a tooltip. */
export function compactTokens(value: number | null): string {
  if (value === null) return "unknown";
  const trim = (text: string) => text.replace(/\.?0+$/, "");
  if (value >= 1e9) return `${trim((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${trim((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${trim((value / 1e3).toFixed(1))}K`;
  return String(value);
}

/** Singular/plural noun for an integer count. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** A token count written short, with the exact count on hover. */
export function tokensShort(value: number | null): HTMLElement {
  const element = document.createElement("span");
  element.textContent = compactTokens(value);
  if (value !== null) element.title = `${tokens(value)} tokens`;
  return element;
}

/** Label and one-line explanation per cache-loss cause (CAUSE-1). */
export const CAUSE: Readonly<Record<MissCauseKind, readonly [string, string]>> = {
  modelSwitch: ["Model switched", "A different model cannot use the old model's cache."],
  compaction: ["Conversation compacted", "Compaction rewrites the history, so the old cache no longer matches."],
  idleBeyondLifetime: ["Pause too long", "The pause was longer than the cache usually lasts."],
  prematureLoss: ["Lost too early", "The cache was gone before its usual lifetime ran out."],
};

export function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  const s = Math.round(seconds);
  const two = (big: number, bigUnit: string, small: number, smallUnit: string) => (small === 0 ? `${big} ${bigUnit}` : `${big} ${bigUnit} ${small} ${smallUnit}`);
  if (s < 60) return `${s} s`;
  if (s < 3600) return two(Math.floor(s / 60), "min", s % 60, "s");
  if (s < 86400) return two(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "min");
  return two(Math.floor(s / 86400), "d", Math.floor((s % 86400) / 3600), "h");
}

export function time(epochMillis: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(epochMillis);
}

export function model(name: string | null, source: string | null): string {
  if (name === null) return "unknown model";
  return source === "assumed" ? `${name} (assumed)` : name;
}

export function harness(id: string | null): string {
  return id === "claudeCode" ? "Claude Code" : id === "antigravity" ? "Antigravity" : id === "codex" ? "Codex" : id === "opencode" ? "OpenCode" : "all";
}

/** The repository a project path belongs to: a harness worktree (`…/repo/.claude/worktrees/x/…`) counts as its repo. */
export function repository(path: string | null): string {
  if (path === null) return "unknown project";
  const root = path.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0] as string;
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

/** The last two parts of a project path, enough to recognize it. */
export function project(path: string | null): string {
  if (path === null) return "unknown";
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

/** Short human-readable label for a session ID when no title or project is recorded (e.g. `subagent #a897e0df`). */
export function shortSessionId(sessionId: string, isSubagent = false): string {
  const raw = sessionId.includes(":") ? (sessionId.split(":").at(-1) as string) : sessionId;
  const short = raw.length > 10 ? raw.slice(0, 8) : raw;
  return isSubagent ? `subagent #${short}` : `#${short}`;
}

/**
 * The declared lifetime (DECL-1) of a harness and model in words. `main` is the promise made on most calls (ties go
 * to the shorter one); `shares` gives every promise with its share of calls, so a mix such as 1 h and 5 min shows.
 */
export function promise(groups: readonly DeclaredGroup[], harnessId: string, modelName: string | null, source: string | null): { main: string; shares: string; latest: string } | null {
  const g = groups.find((x) => x.harness === harnessId && x.model === modelName && x.modelSource === source);
  if (g === undefined) return null;
  const total = g.lifetimes.reduce((a, l) => a + l.calls, 0);
  const name = (seconds: number | null) => (seconds === null ? "nothing declared" : duration(seconds));
  const top = g.lifetimes.reduce((best, l) => (l.calls > best.calls ? l : best), g.lifetimes[0] as DeclaredGroup["lifetimes"][number]);
  return {
    main: name(top.seconds),
    shares: g.lifetimes.map((l) => `${name(l.seconds)} on ${((l.calls / total) * 100).toFixed(0)}% (${tokens(l.calls)} ${plural(l.calls, "call")})`).join(" · "),
    latest: name(g.latestSeconds),
  };
}
