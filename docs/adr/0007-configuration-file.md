# 0007. Configuration file: strict JSON, shipped defaults plus one user override

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-13, R-16, R-23, R-24, R-26, R-51a, R-63, R-71, R-72

## Context

R-72 requires all thresholds, multipliers and paths to live in one documented configuration file, with no magic numbers in code. R-51a requires a user-editable, dated price table. R-24 requires configurable log locations. R-10 and R-71 require the same configuration to produce the same output, so the configuration in effect must be visible and reproducible. R-63 requires every recommendation to show the parameters it used.

ADR 0004 forbids runtime dependencies, and R-26 requires the configuration to work the same way inside a VS Code extension.

## Decision

### Format

- **Strict JSON**, parsed with the built-in `JSON.parse`. No comments, no trailing commas.
- Every key and its meaning, unit, default and allowed range is documented in `docs/configuration.md`. That document is updated in the same change as any key (AGENTS.md section 6).
- Keys are `camelCase` and carry their unit in the name when they have one: `…Seconds`, `…Tokens`, `…PerMillionTokens`. No unitless durations or sizes.
- The file has a top-level integer `schemaVersion`.

### Files and precedence

1. **`config/default.json`** ships with the product and is the single source of every default value. Code reads values only from the validated configuration object and never declares a fallback constant.
2. **One optional user file** uses the same schema and contains only the keys the user wants to change. It is merged over the defaults:
   - objects merge key by key, recursively;
   - arrays and scalar values replace the default as a whole;
   - `null` is not allowed.
3. **User file location:**
   - standalone: the path given with `--config <path>`; otherwise `$XDG_CONFIG_HOME/agent-token-monitor/config.json`, falling back to `~/.config/agent-token-monitor/config.json` on every platform;
   - VS Code: see below.

   If no user file exists, the defaults apply. The tool never creates or rewrites the user file.

### Validation

- The core validates the merged configuration with a hand-written validator in `src/core/config/` (ADR 0006): types, ranges, required keys and cross-field rules.
- **Unknown keys are errors**, so a typo cannot silently fall back to a default.
- A wrong `schemaVersion` is an error that names the expected version. There is no silent migration.
- On any error, the host shows it with the file path and the JSON path of the bad key, and shows **no analysis results** rather than results from a stale or partial configuration (R-23).
- When the user file changes, the host reloads and revalidates it.

### Effective configuration is part of the output

- The merged, validated configuration is available through the data API, shown in the dashboard, and embedded in every exported report (R-10, R-63, R-71).
- Values are serialized with sorted keys, so the same configuration always produces the same bytes.

### Sections

The top-level sections are listed below. The keys inside each section are defined by the ADR that introduces the rule using them, and by `docs/configuration.md`.

```json
{
  "schemaVersion": 1,
  "logRoots":   { "claudeCode": ["~/.claude/projects"], "antigravity": ["…"], "codex": ["…"], "opencode": ["…"] },
  "sessionIndexRoots": { "claudeCode": ["…"], "antigravity": [], "codex": [], "opencode": [] },
  "models":     { "assumed": { "antigravity": "…" } },
  "liveView":   { "…": "…" },
  "cache":      { "…": "…" },
  "rules":      { "…": "…" },
  "pricing":    { "effectiveDate": "YYYY-MM-DD", "currency": "…", "models": { "…": "…" } },
  "ui":         { "pollIntervalSeconds": "…" }
}
```

- `models.assumed` names the model to assume, per harness, for calls whose log records no model (ADR 0009 rule `MODEL-1`). It is empty by default. Its keys must be harness IDs (`claudeCode`, `antigravity`, `codex`, `opencode`); any other key is an error.
- `~` in paths is expanded by the host, not the core, so Windows and Linux paths need no code change (R-24).
- The price table lives inside this file, not in a second file, so there is exactly one configuration file (R-72). How prices and multipliers are represented, including how currency arithmetic stays deterministic, is decided in the pricing ADR.

### No secrets

The schema has no field for keys, tokens or credentials, and the validator rejects unknown keys, so none can be added by accident (R-13).

## Alternatives considered

- **JSONC (JSON with comments):** familiar to VS Code users and self-documenting, but needs a hand-written comment stripper in the core. It can be adopted later by revising this ADR, without changing the schema.
- **YAML or TOML:** more readable, but both need a third-party parser, which ADR 0004 forbids.
- **A full copy of the defaults as the user file:** literally one file, but every new key in a release would break existing user files or require a migration tool.
- **Mirroring every key in VS Code settings:** native editing in the Settings UI, but creates a second source of truth for the same values, and the standalone host and the extension could disagree. This conflicts with R-72.
- **Separate price-table file:** easier to replace prices as a unit, but makes two configuration files, against R-72.

## VS Code compatibility

- The extension reads the same JSON schema through the same core validator. Only the host part differs: it reads the user file with `ConfigSource` and watches it with a VS Code file system watcher.
- The extension contributes **one** setting, `agentTokenMonitor.configPath`. When empty, it uses the same default path as the standalone host, so both hosts share one user file and one set of values.
- An "Open configuration" command opens the user file in the editor, where VS Code's built-in JSON support edits it natively.
- A JSON Schema for editor completion MAY be added later. The core validator stays authoritative.
- Validation errors appear in the Webview the same way they appear in the browser, and MAY also appear as VS Code diagnostics.

## Consequences

- Every threshold has one home, a documented unit and a visible value at run time.
- A misspelled or outdated key fails loudly instead of being ignored.
- Users cannot comment their configuration file. `docs/configuration.md` carries the explanations.
- R-72 ("one configuration file") is read as one schema, with the shipped defaults as the single source of values and one optional user override file.
