// Standalone host: locates and reads configuration files (ADR 0007).
// Path resolution is a pure function of argv, environment and home directory so it can be tested.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config, type ConfigResult } from "../../core/config/config.js";
import type { ConfigSource, UserConfigText } from "../../core/host/index.js";
import type { HarnessId } from "../../core/model/index.js";

const APP_DIR = "agent-token-monitor";
const USER_CONFIG_FILE = "config.json";

/** The shipped defaults, located relative to this module (dist/src/hosts/node → repository root). */
export function defaultConfigPath(): string {
  return fileURLToPath(new URL("../../../../config/default.json", import.meta.url));
}

export interface PathContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string;
}

/** `--config <path>`, else `$XDG_CONFIG_HOME/agent-token-monitor/config.json`, else `~/.config/…` (ADR 0007). */
export function resolveUserConfigPath(context: PathContext): string {
  const fromArgs = configArgument(context.argv);
  if (fromArgs !== null) return resolve(context.cwd, expandHome(fromArgs, context.homeDir));

  const xdg = context.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(context.homeDir, ".config");
  return join(base, APP_DIR, USER_CONFIG_FILE);
}

function configArgument(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--config") return argv[index + 1] ?? null;
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return null;
}

/** Expands a leading `~` to the home directory. Done by the host, never by the core (ADR 0007, R-24). */
export function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeDir, path.slice(2));
  return path;
}

/** Log roots per harness with `~` expanded. */
export function resolveLogRoots(config: Config, homeDir: string): Readonly<Record<HarnessId, readonly string[]>> {
  return expandRoots(config.logRoots, homeDir);
}

/** Folders of session index files (ADR 0016), with `~` expanded. */
export function resolveSessionIndexRoots(config: Config, homeDir: string): Readonly<Record<HarnessId, readonly string[]>> {
  return expandRoots(config.sessionIndexRoots, homeDir);
}

function expandRoots(roots: Readonly<Record<HarnessId, readonly string[]>>, homeDir: string): Readonly<Record<HarnessId, readonly string[]>> {
  const expand = (paths: readonly string[]) => paths.map((path) => expandHome(path, homeDir));
  return { claudeCode: expand(roots.claudeCode), antigravity: expand(roots.antigravity), codex: expand(roots.codex), opencode: expand(roots.opencode) };
}

export class FileConfigSource implements ConfigSource {
  constructor(
    private readonly defaultsPath: string,
    private readonly userPath: string,
  ) {}

  readDefaults(): Promise<string> {
    return readFile(this.defaultsPath, "utf8");
  }

  async readUser(): Promise<UserConfigText | null> {
    try {
      return { path: this.userPath, text: await readFile(this.userPath, "utf8") };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Reads both files and returns the validated configuration or every error found. */
export async function loadConfigFromFiles(defaultsPath: string, userPath: string): Promise<ConfigResult> {
  const source = new FileConfigSource(defaultsPath, userPath);
  let defaultsText: string;
  let user: UserConfigText | null;
  try {
    defaultsText = await source.readDefaults();
  } catch (error) {
    return readFailure(defaultsPath, error);
  }
  try {
    user = await source.readUser();
  } catch (error) {
    return readFailure(userPath, error);
  }
  return loadConfig({ defaults: { path: defaultsPath, text: defaultsText }, user });
}

function readFailure(file: string, error: unknown): ConfigResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, errors: [{ file, path: "", message: `cannot read configuration: ${detail}` }] };
}
