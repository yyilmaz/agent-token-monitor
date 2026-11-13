# 0008. Normalized data model

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-16, R-17, R-18, R-20, R-22, R-23, R-26, R-40, R-70

## Context

Each harness writes a different log format (R-22). Analysis must run on one shared model, so that cache classification, lifetime, TTL replay and rules are written once and work for every harness, including future ones.

The model must keep unknown values unknown (R-16), let every number be traced back to log lines (R-17), carry no prompt text, code or file contents (R-18), and cross host boundaries unchanged (R-26).

Observed log field structure:

- **Claude Code:** one `assistant` line per content block. Several lines can belong to the same API request (same `requestId` and `message.id`), and each repeats the same `message.usage`. The usage has `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens` and `output_tokens`. `isSidechain` marks subagent traffic.
- **Antigravity:** `PLANNER_RESPONSE` steps carry `input_tokens`, `cache_read_tokens`, `output_tokens` and `created_at`. There is no cache-write field. `CHECKPOINT` steps (compaction) carry no token counts.
- **Codex:** `token_count` events and `token_usage_record` entries carry per-turn and cumulative usage, including `cached_input_tokens` and `cache_write_input_tokens`. `input_tokens` includes cached tokens. `rate_limits` carries quota samples.

## Decision

The model is defined as TypeScript types in `src/core/model/` (ADR 0006). Adapters produce it; analysis consumes it.

### General rules

1. **Plain data only:** objects, arrays, strings, integers, booleans and `null`. No classes, `Date`, `Map` or `undefined`. The model serializes to JSON and back without loss, so it can cross HTTP, `postMessage` and the exported report unchanged.
2. **`null` means unknown, and only that.** A value the log does not record is `null`. An adapter MUST NOT write `0` for a value it does not know (R-16).
   - Exception: an adapter MAY record `0` when the harness's provider has no such billing category at all (for example, no separately billed cache writes). The adapter's documentation states this, and a fixture test pins it.
3. **Timestamps** are integer milliseconds since the Unix epoch, UTC. Time zones apply only at display and day-bucketing time, from configuration.
4. **Token counts** are non-negative integers.
5. **Every record carries its source** as `{ logRoot, file, line }`: the configured log root key, the file path relative to that root, and the 1-based line number. A record built from several lines lists all of them (R-17).
6. **IDs are stable strings** built from harness data, never from random values or counters: `"<harness>:<native id>"`.
7. **Canonical order:** sessions by `(harness, id)`; calls and events by `(timestamp, file, line)`. Adapters return records in this order, and analysis may rely on it (R-10).
8. **No content:** no prompt text, model output, tool arguments, file paths read by tools, or file contents. Tool **names** are allowed because classification needs them (R-18). An adapter MAY read a shell tool's command while reading the line, only to classify it (ADR 0017 `STEP-1`); it stores the class, never the command.

### Records

**Session**
- `id`, `harness`, `nativeId`
- `parentSessionId` (`null` when not a subagent), `isSubagent`
- `projectPath`: the working directory as logged, or `null`. Shown and exported as recorded (R-71).
- `sources`

**Call**: one billed model request.
- `id`, `sessionId`, `timestamp`, `model` (`null` if not logged)
- `kind`: `"turn"` or `"compaction"`. A compaction call that the harness does not log tokens for has all token fields `null`.
- `inputUncached`, `cacheRead`, `cacheWrite`, `output`, `reasoning`: each an integer or `null`
- `cacheWriteByTtlSeconds`: an object such as `{ "300": 1200, "3600": 0 }` when the log splits writes by lifetime, otherwise `null`
- `toolNames`: string array
- `shellClasses`: the `STEP-1` class (`"edit"`, `"explore"` or `"other"`) of each shell tool call, in call order (ADR 0017)
- `sources`

`contextSize` is not stored. Analysis derives it as `inputUncached + cacheRead + cacheWrite` when all three are known, and `null` otherwise.

**Adapters MUST collapse every log line of the same request into one Call.** For Claude Code, lines with the same request ID are one Call, and their repeated usage is counted once. A fixture test pins this for every adapter.

**Event**
- `id`, `sessionId`, `timestamp`, `sources`
- `type`: `"userTurn"`, `"compaction"`, `"subagentSpawn"` (with `childSessionId`) or `"error"`
- `compaction`: for a `"compaction"`, what the harness logs about it (`trigger`: `"manual"` or `"auto"`, `preTokens`, `postTokens`), each `null` when not logged; `null` for other types and for harnesses that log none (ADR 0017 `COMPACT-1`)

Model switches are not events: analysis derives them from consecutive calls.

**QuotaSample**: only where the harness logs it.
- `harness`, `timestamp`, `window` (label as logged), `windowSeconds`, `usedPercent`, `resetsAt` (each `null` if not logged), `sources`

**Diagnostic**: what an adapter could not read or understand (R-23).
- `harness`, `severity` (`"error"` or `"warning"`), `code` (stable string), `message` (fixed English text, never log content), `sources`

### Adapter output and capabilities

Every adapter returns `{ sessions, calls, events, quotaSamples, diagnostics }` and declares a static **capability table**. For each token field, the table says whether the harness records it, derives it by a named rule (for example, Codex `inputUncached = input_tokens − cached_input_tokens`), records `0` by the billing exception above, or does not record it. The dashboard uses this table to explain every `unknown` and every normalized value (R-16, R-17).

### Aggregation rule

When analysis sums a field over many records, it never treats `null` as `0`. An aggregate reports the sum of known values together with the number of records whose value was unknown, for example "1,204,551 tokens, plus 3 calls with unknown tokens".

## Alternatives considered

- **A tagged unknown value (`{ unknown: true, reason }`) in every field:** carries the reason with each value, but makes every record several times larger and every computation heavier. The capability table gives the same explanation once per harness and field.
- **Storing `contextSize` on each Call:** convenient, but it would duplicate a derived value and could disagree with its parts.
- **Model switches as events:** would let each adapter detect them differently. Deriving them in analysis gives one rule for all harnesses.
- **Using log line order instead of timestamps for ordering:** breaks when a session spans several files or a harness writes out of order.

## VS Code compatibility

- The model is plain, JSON-safe data defined in `src/core`, which has no host dependency (ADR 0006). The VS Code host passes the same records to analysis and to the Webview through `postMessage` with no conversion.
- Sources are relative to configured log roots, so the extension resolves them against the same configuration (ADR 0007), and can later open a referenced log location in the editor if that is wanted.

## Consequences

- A new harness needs only an adapter, a capability table and fixtures. Analysis does not change.
- Unknown values stay visible all the way to the dashboard.
- Request deduplication is an explicit, tested adapter duty. Without it, Claude Code usage would be counted several times.
- Model content never enters the model, so it cannot leak through the API, the Webview or an export.
