// VS Code host: resolves agentTokenMonitor.configPath, falling back to XDG / ~/.config (ADR 0007, ADR 0021).

import { isAbsolute, resolve } from "node:path";

import { expandHome, resolveUserConfigPath } from "../node/config.js";

export interface VsCodeConfigPathContext {
  readonly configuredPath: string;
  readonly workspaceDirs: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

/**
 * Resolves `agentTokenMonitor.configPath` when non-empty (expanding leading `~` and resolving relative paths against
 * the first workspace folder or `homeDir`), or falls back to the standard user config path when empty (ADR 0021).
 */
export function resolveVsCodeConfigPath(context: VsCodeConfigPathContext): string {
  const trimmed = context.configuredPath.trim();
  const baseDir = context.workspaceDirs[0] ?? context.homeDir;
  if (trimmed !== "") {
    const expanded = expandHome(trimmed, context.homeDir);
    return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  }
  return resolveUserConfigPath({ argv: [], env: context.env, homeDir: context.homeDir, cwd: baseDir });
}
