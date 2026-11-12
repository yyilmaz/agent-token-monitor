# Configuration

All thresholds, multipliers and paths live in one configuration schema ([SRS](SRS.md) R-72, [ADR 0007](adr/0007-configuration-file.md)). Code contains no fallback values.

## Files

| File | Role |
|---|---|
| [`config/default.json`](../config/default.json) | Ships with the product. Single source of every default value. |
| User file (optional) | Same schema, only the keys you want to change. Merged over the defaults. |

The user file is looked up in this order:

1. the path given with `--config <path>` (or `--config=<path>`), relative to the working directory;
2. `$XDG_CONFIG_HOME/agent-token-monitor/config.json`, when `XDG_CONFIG_HOME` is set to an absolute path;
3. `~/.config/agent-token-monitor/config.json`.

If no user file exists, the defaults apply. The tool never creates or rewrites it. Inside VS Code, the setting `agentTokenMonitor.configPath` will select the file; when empty, the same default path is used.

## Rules

- Strict JSON: no comments, no trailing commas.
- **Merge:** objects merge key by key; arrays and single values replace the default as a whole.
- **Unknown keys are errors.** A misspelled key is reported, never ignored.
- `null` is not allowed.
- `schemaVersion` must match the version the tool expects (currently `2`). There is no silent migration. For a version 1 user file, remove the `pricing` key if present and update an explicit `schemaVersion` to `2`.
- On any error, the tool shows the file, the key path and the reason, and shows no analysis results.
- A leading `~` in paths means your home directory.
- The configuration in effect is shown in the dashboard and embedded in exported reports (R-10, R-71).

Example user file that points Claude Code at a second log directory and lowers the full-miss threshold:

```json
{
  "logRoots": { "claudeCode": ["~/.claude/projects", "/Volumes/backup/claude-projects"] },
  "cache": { "fullMissMinContextTokens": 10000 }
}
```

## Keys

### `schemaVersion`

Integer. Version of this schema. Default: `2`.

### `logRoots`

Where each harness writes its logs (R-24). Each is an array of directory paths; arrays replace the default as a whole.

| Key | Default | Notes |
|---|---|---|
| `logRoots.claudeCode` | `["~/.claude/projects"]` | |
| `logRoots.antigravity` | `["~/.gemini/antigravity/brain"]` | |
| `logRoots.codex` | `["~/.codex/sessions"]` | Reads `rollout-*.jsonl` files recursively. For a custom Codex home, point this at its `sessions` directory. Add `~/.codex/archived_sessions` to include archived rollouts ([ADR 0018](adr/0018-codex-adapter.md)). |
| `logRoots.opencode` | `["~/.local/share/opencode"]` | Phase 2 (R-21). Until its adapter exists, only the presence of `opencode.db` is checked; the database is never opened (R-15) |

### `sessionIndexRoots`

Where a harness's app keeps one index file per session, with its title and the session that started it ([ADR 0016](adr/0016-session-titles-and-tree.md)). Read-only, like log roots; a missing folder is not an error. Arrays replace the default as a whole.

| Key | Default | Notes |
|---|---|---|
| `sessionIndexRoots.claudeCode` | `["~/Library/Application Support/Claude/claude-code-sessions"]` | The Claude desktop app on macOS; set your platform's path elsewhere (R-24) |
| `sessionIndexRoots.antigravity` | `["~/.gemini/antigravity/annotations"]` | Antigravity per-conversation `.pbtxt` annotation files (`title`) |
| `sessionIndexRoots.codex` | `[]` | |
| `sessionIndexRoots.opencode` | `[]` | |

### `usage`

| Key | Default | Allowed | Used by |
|---|---|---|---|
| `timeZone` | `"system"` | `"system"` or an IANA time zone name such as `"Europe/Istanbul"` | `USE-1` ([ADR 0013](adr/0013-server-data-api-and-dashboard.md)): the day and month a call belongs to. `"system"` uses the zone the host reports; every response names the zone used |

### `liveView`

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `openWithinSeconds` | seconds | `1800` | integer ≥ 1 | `LIVE-1`: a session is open when its last call is at most this long ago |

### `cache`

Cache classification, observed lifetime and miss causes ([ADR 0009](adr/0009-cache-classification-lifetime-and-miss-causes.md)).

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `fullMissMinContextTokens` | tokens | `20000` | integer ≥ 0 | `CLS-1`: a call with no cache read below this context size is `belowThreshold`, not `fullMiss` |
| `hitToleranceTokens` | tokens | `1024` | integer ≥ 0 | `CLS-1`: re-read tokens up to this count still count as `hit` |
| `survivedMinCacheReadShare` | ratio | `0.75` | 0 to 1 | `LOSS-1`: a partial hit that read less than this share of the previous context from cache is a cache loss |
| `lifetimeBandEdgesSeconds` | seconds | `[60, 300, 900, 1800, 3600, 7200, 21600, 86400]` | integers ≥ 1, strictly ascending, at least one | `OBS-1`: gap bands for survived and gone counts |
| `minLifetimeObservations` | count | `20` | integer ≥ 1 | `LIFE-1`: fewer observations show "insufficient data" |
| `declaredLifetimeSeconds.<harness>.<model>` | seconds | none | integer ≥ 1 | `DECL-1`: declared lifetime when the log does not record one |
| `referenceLifetimeSeconds.<harness>` | seconds | `300` for each harness | integer ≥ 1 | `CAUSE-1`: last-resort reference lifetime |

`<harness>` is one of `claudeCode`, `antigravity`, `codex`, `opencode`.

### `models`

| Key | Default | Allowed | Used by |
|---|---|---|---|
| `models.assumed.<harness>` | none | non-empty model name; keys must be harness IDs | `MODEL-1` ([ADR 0009](adr/0009-cache-classification-lifetime-and-miss-causes.md)): the model assumed for calls whose log records none |

Antigravity does not log the model. If you always use the same one, set it here so lifetimes and model-based results can be computed; every such result is labeled `assumed`. Calls made with another model are then attributed to this one. Where the model choice includes an effort level, write it into the name:

```json
{ "models": { "assumed": { "antigravity": "gemini-3-pro-high" } } }
```

### `rules`

Session advice ([ADR 0017](adr/0017-session-advice.md), R-60, R-62, R-63). Context bands are half-open, `[from, to)`; the first starts at `0` and the last is open.

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `freshSession.minSessions` | count | `5` | integer ≥ 1 | `FRESH-1`: fewer top-level sessions leave the typical fresh start, and the advice built on it, `unknown` |
| `sessionAdvice.minCompactions` | count | `5` | integer ≥ 1 | `POSTCOMPACT-1`, `SUMMARY-1` ([ADR 0017](adr/0017-session-advice.md)): fewer compactions make the figure, and the advice, unknown |
| `sessionAdvice.minSessions` | count | `5` | integer ≥ 1 | `REMAIN-1` (ADR 0017): fewer sessions in a context band make the figure, and the advice, unknown |
| `sessionAdvice.contextBandEdgesTokens` | tokens | `[50000, 100000, 200000, 500000]` | integers ≥ 1, strictly ascending, at least one | `REMAIN-1` and `WORKFLOW-1` (ADR 0017): context-size bands |
| `sessionAdvice.recentTurnsWindow` | count | `5` | integer ≥ 1 | `WORKFLOW-1` (ADR 0017): number of most recent turns used for the recent step load average |
| `sessionAdvice.weights` | multiplier | `{ cacheRead: 0.1, inputUncached: 1, cacheWrite: 1.25, output: 5 }` | non-negative numbers | Token category weights (`1` = `1` uncached input token) for advice, step and session loads (ADR 0017), and weighted Usage totals (ADR 0013) |

### `ui`

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `pollIntervalSeconds` | seconds | `5` | integer ≥ 1 | How often the dashboard asks for fresh data (R-32, [ADR 0005](adr/0005-frontend-single-page-typescript.md)) |
| `usageRangesDays` | days | `[7, 30]` | integers ≥ 1, strictly ascending, at least one | The Usage summary always offers **Today** and adds these ranges. A value of `1` uses the **Today** option. Each range is compared with the same number of days before it (R-33) |
| `subagentRowsShown` | rows | `10` | integer ≥ 1 | How many subagent rows a session's table shows before **Show more**, newest first ([ADR 0016](adr/0016-session-titles-and-tree.md)) |
| `diagnosticLocationsShown` | locations | `5` | integer ≥ 1 | How many log locations (`file:line`) each group in the Diagnostics view lists; the group's count says how many exist (R-23, [ADR 0013](adr/0013-server-data-api-and-dashboard.md)) |

