// Configuration schema, validation and merge (ADR 0007, R-72).
// Every default value lives in config/default.json; this module declares shapes only.

import { array, HARNESS_KEYS, integer, object, optional, perHarness, rate, record, string, tokenWeight, type Infer } from "./schema.js";
import { validate, type ValidationError } from "./validate.js";

/** Version of the configuration schema. Bumped when keys change incompatibly. */
export const CONFIG_SCHEMA_VERSION = 2;

export const configSchema = object({
  schemaVersion: integer(1),
  logRoots: perHarness(array(string())),
  sessionIndexRoots: perHarness(array(string())),
  usage: object({
    timeZone: string(),
  }),
  liveView: object({
    openWithinSeconds: integer(1),
  }),
  cache: object({
    fullMissMinContextTokens: integer(0),
    hitToleranceTokens: integer(0),
    survivedMinCacheReadShare: rate(),
    lifetimeBandEdgesSeconds: array(integer(1), { minItems: 1, strictlyAscending: true }),
    minLifetimeObservations: integer(1),
    declaredLifetimeSeconds: perHarness(record(integer(1))),
    referenceLifetimeSeconds: perHarness(integer(1)),
  }),
  models: object({
    assumed: record(string(), { keys: HARNESS_KEYS }),
  }),
  rules: object({
    freshSession: object({ minSessions: integer(1) }),
    sessionAdvice: object({
      minCompactions: integer(1),
      minSessions: integer(1),
      contextBandEdgesTokens: array(integer(1), { minItems: 1, strictlyAscending: true }),
      recentTurnsWindow: optional(integer(1)),
      weights: optional(
        object({
          cacheRead: tokenWeight(),
          inputUncached: tokenWeight(),
          cacheWrite: tokenWeight(),
          output: tokenWeight(),
        }),
      ),
    }),
  }),
  ui: object({
    pollIntervalSeconds: integer(1),
    usageRangesDays: array(integer(1), { minItems: 1, strictlyAscending: true }),
    // ADR 0016: rows a session's subagent table shows before "Show more".
    subagentRowsShown: integer(1),
    // ADR 0013: log locations the Diagnostics view lists per group before the rest are only counted (R-23).
    diagnosticLocationsShown: integer(1),
  }),
});

export type Config = Infer<typeof configSchema>;

export interface ConfigError {
  /** File the error belongs to (as given by the host). */
  readonly file: string;
  /** Dotted path of the offending key; empty for the whole document. */
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export interface ConfigInput {
  readonly defaults: { readonly path: string; readonly text: string };
  readonly user: { readonly path: string; readonly text: string } | null;
}

/**
 * Parses, validates and merges the shipped defaults with the optional user file.
 * Any error yields no configuration at all: callers must not fall back to partial values (ADR 0007).
 */
export function loadConfig(input: ConfigInput): ConfigResult {
  const defaults = parseDocument(input.defaults.path, input.defaults.text, false);
  if (!defaults.ok) return defaults;

  let merged: unknown = defaults.value;
  if (input.user !== null) {
    const user = parseDocument(input.user.path, input.user.text, true);
    if (!user.ok) return user;
    merged = mergeConfig(defaults.value, user.value);
  }

  // Reaching here with errors means the shipped defaults are incomplete or invalid.
  const errors = toConfigErrors(input.defaults.path, validate(configSchema, merged, { partial: false }));
  if (errors.length > 0) return { ok: false, errors };
  const crossField = crossFieldErrors(merged as Config);
  if (crossField.length > 0) {
    return { ok: false, errors: toConfigErrors(input.user?.path ?? input.defaults.path, crossField) };
  }
  return { ok: true, config: merged as Config };
}

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly errors: readonly ConfigError[] };

function parseDocument(file: string, text: string, partial: boolean): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ file, path: "", message: `not valid JSON: ${detail}` }] };
  }

  const errors = toConfigErrors(file, validate(configSchema, value, { partial }));
  if (errors.length > 0) return { ok: false, errors };

  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version !== undefined && version !== CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          file,
          path: "schemaVersion",
          message: `expected schemaVersion ${CONFIG_SCHEMA_VERSION}, found ${String(version)}; update the file to the current schema`,
        },
      ],
    };
  }
  return { ok: true, value };
}

/** Rules that span several keys (ADR 0007), checked on the merged configuration. */
function crossFieldErrors(config: Config): ValidationError[] {
  const errors: ValidationError[] = [];
  // ADR 0013: "system" or a time zone the built-in Intl knows.
  if (config.usage.timeZone !== "system") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.usage.timeZone });
    } catch {
      errors.push({ path: "usage.timeZone", message: `unknown time zone ${JSON.stringify(config.usage.timeZone)}; use "system" or an IANA name such as "Europe/Istanbul"` });
    }
  }
  return errors;
}

function toConfigErrors(file: string, errors: readonly ValidationError[]): ConfigError[] {
  return errors.map((error) => ({ file, path: error.path, message: error.message }));
}

/** Objects merge key by key, recursively; arrays and scalars replace the base value (ADR 0007). */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = key in base ? mergeConfig(base[key], override[key]) : override[key];
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with keys sorted at every level, so equal configurations serialize to equal bytes (R-10, R-71). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}
