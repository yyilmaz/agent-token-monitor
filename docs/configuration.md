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
- `schemaVersion` must match the version the tool expects (currently `1`). There is no silent migration.
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

Integer. Version of this schema. Default: `1`.

### `logRoots`

Where each harness writes its logs (R-24). Each is an array of directory paths; arrays replace the default as a whole.

| Key | Default | Notes |
|---|---|---|
| `logRoots.claudeCode` | `["~/.claude/projects"]` | |
| `logRoots.antigravity` | `["~/.gemini/antigravity/brain"]` | |
| `logRoots.codex` | `["~/.codex/sessions"]` | Phase 2 (R-21). Until its adapter exists, `rollout-*.jsonl` files here are only listed, never read, so Usage can say Codex is found but not counted (R-23) |
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
| `sessionAdvice.weights` | multiplier | `{ cacheRead: 0.1, inputUncached: 1, cacheWrite: 1.25, output: 5 }` | non-negative numbers | `WORKFLOW-1` (ADR 0017): token category weights (`1` = `1` uncached input token) for comparing step and session loads |

### `pricing`

The local price table for currency figures ([ADR 0011](adr/0011-pricing.md), R-51a). Values are API list-price equivalents, not your bill. The product ships the published list prices of the current Claude models and Gemini 4 Argon, copied by hand from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-11-01. Nothing is fetched from the network: when prices change, update `config/default.json` or override a model in your user file. A model with no price, such as Antigravity's unlogged model, shows `unknown`.

| Model | Input | 5 min cache write | 1 h cache write | Cache read | Output |
|---|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 12.50 | 20 | 0.25 | 50 |
| `claude-opus-5-5` | 4 | 5 | 8 | 0.20 | 20 |
| `claude-sonnet-5-5` | 2 | 2.50 | 4 | 0.10 | 10 |
| `claude-haiku-5-5`, context up to 100,000 tokens | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
| `claude-haiku-5-5`, context over 100,000 tokens | 0.50 | 0.625 | 1 | 0.05 | 2.50 |
| `gemini-4-argon`, until 2026-11-30 | 2 | none | none | 0.10 | 10 |
| `gemini-4-argon`, from 2026-12-01 | 4 | none | none | 0.20 | 20 |

USD per million tokens. The Claude models other than Haiku 5.5 have no long-context tier: their full context window is priced at the standard rate. `gemini-4-argon` comes from [Google's Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing) (checked 2026-11-01): output includes thinking tokens, and caching is implicit only, so there is no cache-write price. Google has announced that its price doubles on 2026-12-01; the shipped entry carries that as a `changes` entry, so calls from that day on are priced at the new rate and earlier calls keep the old one.

Antigravity does not log its model, so these prices apply to it only once `models.assumed.antigravity` names one (below). Antigravity also does not log thinking tokens, so its currency figures leave out thinking and are lower than the real list-price equivalent.

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `currency` | | `"USD"` | ISO 4217 code, three capital letters | Label only; there is no conversion |
| `displayDecimals` | places | `2` | integer ≥ 0 | Display rounding, half to even; sums are never rounded |
| `models.<model>.effectiveDate` | date | the shipped models: `2026-11-01` | `YYYY-MM-DD` | The day these prices were checked or took effect; shown next to every currency figure of the model. Calls before it are priced with them too, as the earliest prices known |
| `models.<model>.tiers[]` | | the shipped models: as listed above | at least one; `minContextTokens` starts at `0` and ascends strictly | `PRICE-2`: a call pays the prices of the last tier whose `minContextTokens` is at most its context size |
| `…tiers[].minContextTokens` | tokens | | integer ≥ 0 | |
| `…tiers[].inputPerMillionTokens` | currency per million tokens | | ≥ 0, at most 6 decimal places | Uncached input |
| `…tiers[].outputPerMillionTokens` | currency per million tokens | | ≥ 0, at most 6 decimal places | Output, including reasoning |
| `…tiers[].cacheReadPerMillionTokens` | currency per million tokens | | ≥ 0, at most 6 decimal places | Cache reads |
| `…tiers[].cacheWritePerMillionTokensByTtlSeconds.<seconds>` | currency per million tokens | | ≥ 0, at most 6 decimal places; key a whole number of seconds | Cache writes of that lifetime. A lifetime with no price uses the shortest longer listed one, else the longest; the result says so |
| `models.<model>.changes[]` | | optional; `gemini-4-argon`: 2026-12-01 | at least one when present; each `{ "effectiveDate", "tiers" }` with the same rules as above, dates strictly later than the one before | Announced price changes. A call pays the prices in force on its UTC date: the last `effectiveDate` on or before it. Session advice uses the prices in force now |

`<model>` is the effective model name: the one in the log, or `models.assumed.<harness>`. Example with a higher price above 200,000 tokens of context (the numbers are placeholders, not real prices):

```json
{
  "pricing": {
    "models": {
      "example-model": {
        "effectiveDate": "2026-10-01",
        "tiers": [
          { "minContextTokens": 0, "inputPerMillionTokens": 3, "outputPerMillionTokens": 15,
            "cacheReadPerMillionTokens": 0.3, "cacheWritePerMillionTokensByTtlSeconds": { "300": 3.75, "3600": 6 } },
          { "minContextTokens": 200001, "inputPerMillionTokens": 6, "outputPerMillionTokens": 22.5,
            "cacheReadPerMillionTokens": 0.6, "cacheWritePerMillionTokensByTtlSeconds": { "300": 7.5, "3600": 12 } }
        ]
      }
    }
  }
}
```

### `ui`

| Key | Unit | Default | Allowed | Used by |
|---|---|---|---|---|
| `pollIntervalSeconds` | seconds | `5` | integer ≥ 1 | How often the dashboard asks for fresh data (R-32, [ADR 0005](adr/0005-frontend-single-page-typescript.md)) |
| `usageRangesDays` | days | `[7, 30]` | integers ≥ 1, strictly ascending, at least one | The ranges the Usage summary offers; each is compared with the same number of days before it (R-33) |
| `subagentRowsShown` | rows | `10` | integer ≥ 1 | How many subagent rows a session's table shows before **Show more**, newest first ([ADR 0016](adr/0016-session-titles-and-tree.md)) |

