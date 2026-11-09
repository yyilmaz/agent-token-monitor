# 0017. Session advice: keep going, compact or start fresh

- Status: Accepted
- Date: 2026-11-09
- Requirements: R-10, R-11, R-16, R-17, R-22, R-30, R-51, R-60, R-62, R-63, R-72

## Context

An open session can continue, compact its history into a summary, or start fresh. Compaction processes the current context and produces summary tokens, then later calls process the smaller context. A new session starts from its own baseline. R-60 requires an expected token saving based on the user's history, and R-51 limits the comparison to token units.

Claude Code logs what this needs. Each `compact_boundary` line carries `compactMetadata` with `trigger` (`manual` or `auto`), `preTokens` (context before) and `postTokens` (summary size), next to the session's calls before and after it. Antigravity logs a `CHECKPOINT` step without token counts.

## Decision

All rules are pure functions in `src/core/analysis/` over the normalized model (ADR 0008), the cache analysis (ADR 0009) and the configured token weights. They look only at sessions that are not subagents: the user drives those, so only they can act on the advice.

### Compaction figures in the data model

**Rule `COMPACT-1` (adapter).** A compaction Event (ADR 0008) gains `compaction: { trigger, preTokens, postTokens } | null`. The Claude Code adapter fills it from `compactMetadata`; any field the line lacks is `null`, and an adapter whose harness logs none (Antigravity) sets `null` (R-16, R-22). Fixture tests pin the mapping.

### Figures from the user's own history

Per harness and effective model (ADR 0009 `MODEL-1`), over the whole history. With an even count, each median takes the lower middle value. Below its minimum count each figure is `unknown`.

- **`FRESH-1`, typical start of a new session:** the median context size (`inputUncached + cacheRead + cacheWrite`) of the first turn call of every session that is not a subagent. At least `rules.freshSession.minSessions` sessions.
- **`POSTCOMPACT-1`, context after compacting:** the median context size (`inputUncached + cacheRead + cacheWrite`) of the first turn call after each compaction Event in the same session. At least `rules.sessionAdvice.minCompactions` compactions.
- **`SUMMARY-1`, summary size:** the median `postTokens` of those compactions. The summarization request itself is not logged (ADR 0008), so its output is taken to be the summary. This is a derived estimate, labeled as one.
- **`REMAIN-1`, messages still to come:** for the context band (`rules.sessionAdvice.contextBandEdgesTokens`) of the session's current context, the median number of turn calls that sessions sent after their context first entered that band. At least `rules.sessionAdvice.minSessions` sessions.

### Weighted token load of each option

**Rule `ADVICE-1`.** For an open top-level session (`LIVE-1`), compare the three options using the existing `rules.sessionAdvice.weights`. The weights express relative token processing load, with one uncached input token as the default unit. Compare integer millionths before converting to display units so fractional weights preserve ties and break-even horizons. Each result uses the configured weights and is labeled **weighted token units**.

Let `C` be the current context, `P` the context after compaction, `S` the summary size, and `F` the fresh context. Let `r`, `w` and `o` be the configured cache-read, cache-write and output weights.

| Option | Initial load | Load per later message |
|---|---|---|
| Keep going, warm | 0 | `C × r` |
| Keep going, cold | `C × w` | `C × r` |
| Compact, warm | `C × r + S × o + S × w` | `P × r` |
| Compact, cold | `C × w + S × o + P × w` | `P × r` |
| Start fresh | `F × w` | `F × r` |

A session is cold when `LIVE-1` reports `probably cold` or `missed on last call`. The model treats later messages as cache reads and omits their common output load.

Use `REMAIN-1` as the horizon `H`. An option's total is its initial load plus `H` times its load per later message. Choose the lowest total, with ties resolved in order: keep going, compact, start fresh. Expected saving is the difference between the keep-going total and the chosen total. For alternatives, report the first nonnegative whole-message horizon at which their total is no greater than the keep-going total. If an option starts above the keep-going total and has an equal or greater per-message load, it never breaks even. If a required historical figure is missing, report `unknown` and identify the missing figure.

### Workflow profile and subagent split break-even

**Rule `WORKFLOW-1`.** For every open top-level session, the analysis also computes its deterministic workflow profile from the session's active context window (turn calls after the session's latest `compaction` event, or all turn calls when the session has not been compacted) and subagents:

- `turns`: number of turn calls in the active context window (0 immediately after a compaction before the next turn).
- `editTurns`: active-window turn calls that invoked at least one edit/write tool (`edit_file`, `write_file`, `replace_file_content`, `multi_replace_file_content`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `apply_patch`).
- `exploreTurns`: active-window turn calls that invoked read/search tools (`read_file`, `view_file`, `view_file_outline`, `view_code_item`, `grep`, `grep_search`, `find_by_name`, `list_dir`, `Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, `search_web`) and no edit/write tool.
- `firstContextTokens`: context size of the first turn call in the active context window (falling back to the session's first turn call when just compacted).
- `baseContextTokens`: `FRESH-1` when known, else `firstContextTokens`.
- `recentGrowthTokens`: context growth over up to the last 3 turn intervals in the active window (`context(last) − context(max(0, last − 3))`).
- `subagentCount`, `activeSubagentCount` and `subagentTokens`: number of child subagent sessions, how many of them are currently open with a warm cache and a call at or after the parent's last call, and the sum of child subagent known tokens.
- `splitBreakEvenSteps`: when the session is past the lean limit (`max(2 × baseContextTokens, contextBandEdgesTokens[0])`) and `contextTokens > baseContextTokens`, `floor(2 × contextTokens ÷ (contextTokens − baseContextTokens)) + 1`, the minimum number of steps `k` an independent subtask needs before delegating to a subagent (which costs 2 parent turns at `contextTokens` to spawn and receive the reply, plus `k` subagent turns at `baseContextTokens`: `2 × contextTokens + k × baseContextTokens < k × contextTokens`) processes fewer context tokens than continuing at `contextTokens`; otherwise `null`.
- `contextState`:
  - `waitingOnSubagents` when `activeSubagentCount > 0`: one or more child subagents are actively working and will return results to this session; stay in this session rather than starting fresh.
  - `compactActive` immediately after a compaction (0 post-compaction turns) or when `contextTokens < max(2 × baseContextTokens, contextBandEdgesTokens[0])`: context is lean; splitting into a subagent wastes startup context.
  - `coldLargeContext` when `contextTokens ≥ max(2 × baseContextTokens, contextBandEdgesTokens[0])` and the cache is cold: avoid cold compaction; start fresh if the next task is independent.
  - `explorationHeavy` when `contextTokens ≥ max(2 × baseContextTokens, contextBandEdgesTokens[0])`, the cache is warm, `exploreTurns ≥ 3`, `exploreTurns > 2 × editTurns` and `exploreTurns × 2 ≥ turns`: context grew mainly from read/search steps without proportional edits; delegate independent multi-step subtasks (`≥ splitBreakEvenSteps` steps) to a subagent or compact at a phase boundary.
  - `activeWorkingSet` otherwise (`contextTokens ≥ max(2 × baseContextTokens, contextBandEdgesTokens[0])`, warm): large active working set; keep same-module work in this session to reuse the warm cache, and delegate only noisy search or independent subtasks (`≥ splitBreakEvenSteps` steps).

### What the user sees

The Now view shows one recommendation per open top-level session with expected weighted token savings, the horizon and the rule ID. Expandable details show the historical inputs, configured weights, all three totals and break-even points (R-17, R-63). The estimate compares token load. Context discarded by compaction or a fresh session can still matter to the user. The product never takes these actions itself (R-62).

### Parameters

| Key | Default | Why |
|---|---|---|
| `rules.freshSession.minSessions` | 5 | a median of fewer sessions says little |
| `rules.sessionAdvice.minCompactions` | 5 | a median of fewer compactions says little |
| `rules.sessionAdvice.minSessions` | 5 | the same for messages still to come |
| `rules.sessionAdvice.contextBandEdgesTokens` | `[50000, 100000, 200000, 500000]` | half-open context bands `[from, to)` for `REMAIN-1` and lean-context floor for `WORKFLOW-1` |
| `rules.sessionAdvice.recentTurnsWindow` | `5` | recent turns averaged for current step load in `WORKFLOW-1` |
| `rules.sessionAdvice.weights` | `{ cacheRead: 0.1, inputUncached: 1, cacheWrite: 1.25, output: 5 }` | token weights (`1` = `1` uncached input token) for advice and per-step, active-window, session and subagent weighted load |

There are no other thresholds: the advice comes from comparing three totals.

## Alternatives considered

- **Use raw totals for advice.** Easier to explain, but treats cached reads, cache writes and summary output as equally expensive in processing terms. The configured weights already distinguish these categories in the session load view.
- **Use a fixed message horizon.** Requires a user-supplied guess. `REMAIN-1` estimates it from the user's history.
- **Use summary size as the post-compaction context.** Omits the system prompt and tools and overstates the expected saving.

## VS Code compatibility

- `COMPACT-1` is part of the Claude Code adapter; `FRESH-1`, `POSTCOMPACT-1`, `SUMMARY-1`, `REMAIN-1` and `ADVICE-1` are pure functions over the normalized model with no host access (ADR 0006), and run unchanged in the extension host.
- The advice travels in the overview payload as JSON token units. The Webview renders the same data as the browser.
- The parameters live in the configuration file and validator (ADR 0007).

## Consequences

- The expected saving is a weighted token estimate. Its inputs and units are visible in the dashboard.
- `SUMMARY-1` estimates summary output from compaction metadata. When required figures are unavailable, the advice is unknown.
- Usage reports raw token counts and separately labeled weighted token units. Advice reports weighted token units.
