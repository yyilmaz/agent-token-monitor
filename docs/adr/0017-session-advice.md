# 0017. Session advice: keep going, compact or start fresh

- Status: Accepted
- Date: 2026-11-01
- Requirements: R-10, R-11, R-16, R-17, R-22, R-30, R-51a, R-60, R-62, R-63, R-72

## Context

A long session can go on in three ways: keep sending messages, compact it (the harness replaces the history with a summary), or start a new session. Each has a different price, and which one is cheapest depends on the moment:

- **Compacting is one request that reads the whole context and writes a summary**, after which the shorter context is written to the cache again. With a warm cache, the read is cheap. With a cold cache, the whole context is first paid again in full, only to be summarized and dropped: the user pays twice.
- **The summary is output**, the most expensive token type.
- **Compaction retains a baseline context.** The next call includes the summary, system prompt and tool definitions. The resulting context can exceed the starting context of a fresh session.

R-60 and R-62 ask for concrete advice from fixed rules, with the expected saving from the user's own history.

Claude Code logs what this needs. Each `compact_boundary` line carries `compactMetadata` with `trigger` (`manual` or `auto`), `preTokens` (context before) and `postTokens` (summary size), next to the session's calls before and after it. Antigravity logs a `CHECKPOINT` step without token counts.

## Decision

All rules are pure functions in `src/core/analysis/` over the normalized model (ADR 0008), the cache analysis (ADR 0009) and the price table (ADR 0011). They look only at sessions that are not subagents: the user drives those, so only they can act on the advice.

### Compaction figures in the data model

**Rule `COMPACT-1` (adapter).** A compaction Event (ADR 0008) gains `compaction: { trigger, preTokens, postTokens } | null`. The Claude Code adapter fills it from `compactMetadata`; any field the line lacks is `null`, and an adapter whose harness logs none (Antigravity) sets `null` (R-16, R-22). Fixture tests pin the mapping.

### Figures from the user's own history

Per harness and effective model (ADR 0009 `MODEL-1`), over the whole history. With an even count, each median takes the lower middle value. Below its minimum count each figure is `unknown`.

- **`FRESH-1`, typical start of a new session:** the median context size (`inputUncached + cacheRead + cacheWrite`) of the first turn call of every session that is not a subagent. At least `rules.freshSession.minSessions` sessions.
- **`POSTCOMPACT-1`, context after compacting:** the median context size (`inputUncached + cacheRead + cacheWrite`) of the first turn call after each compaction Event in the same session. At least `rules.sessionAdvice.minCompactions` compactions.
- **`SUMMARY-1`, summary size:** the median `postTokens` of those compactions. The summarization request itself is not logged (ADR 0008), so its output is taken to be the summary. This is a derived estimate, labeled as one.
- **`REMAIN-1`, messages still to come:** for the context band (`rules.sessionAdvice.contextBandEdgesTokens`) of the session's current context, the median number of turn calls that sessions sent after their context first entered that band. At least `rules.sessionAdvice.minSessions` sessions.

### Cost of each option

**Rule `ADVICE-1`.** For an open session (`LIVE-1`) with context `C`, a priced model (ADR 0011) and known figures above. `r`, `w` and `o` are the cache-read, cache-write and output prices of the tier for the context in question. `w` is for the session's declared lifetime (`DECL-1`), else the reference lifetime of `CAUSE-1`. `P` is `POSTCOMPACT-1`, `S` is `SUMMARY-1` and `F` is `FRESH-1`.

| Option | One-time cost now | Cost per later message |
|---|---|---|
| Keep going, cache warm | 0 | `C × r` |
| Keep going, cache cold | `C × w` (the next message writes the cache again) | `C × r` |
| Compact, cache warm | `C × r + S × o + S × w` | `P × r` |
| Compact, cache cold | `C × w + S × o + P × w` | `P × r` |
| New session | `F × w` | `F × r` |

"Cold" is `LIVE-1`'s `probably cold` or `missed on last call`. With a warm cache, the fixed system prompt and tools stay cached after compacting, so only the summary is written. Output tokens of ordinary messages are the same in every option, so they are left out.

Over the horizon `H` = `REMAIN-1`, the total of an option is `one-time + H × per message`. **The advice is the option with the lowest total.** On a tie, the less disruptive one wins: keep going, then compact, then new session. For each option that is not chosen, the advice also shows its **break-even point**: how many more messages it would take to pay off against keeping going, `(one-time − one-time of keeping going) ÷ ((C − its per-message context) × r)`. It shows "never" when the option does not shrink the context.

All figures are exact currency sums (ADR 0011 `PRICE-1`), shown with the label "API list-price equivalent, not your bill".

### Workflow profile and subagent split break-even

**Rule `WORKFLOW-1`.** For every open top-level session, whether or not its model is priced, the analysis also computes its deterministic workflow profile from the session's active context window (turn calls after the session's latest `compaction` event, or all turn calls when the session has not been compacted) and subagents:

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

One tag per open session, next to its cache status on the Now view (R-30). The tag shows a short text, the saving over `H` against keeping going, the totals of the other options (so a close call between compacting and a new session is visible without a threshold), and a link to the figures:

| Tag | Example text |
|---|---|
| `keep going` | "Keep going. Compacting breaks even after five more messages. You usually send about three." |
| `compact now` | "Compact now, while the cache is warm. Saves about $1.38 over your usual 25 messages: compacting costs $1.12, a new session $1.95." (500,000 tokens, for a user whose new sessions start at 150,000) |
| `start fresh` | Warm: "Start a new session. Saves about $3.08 over your usual 69 messages: a new session costs $1.76, compacting $1.92." Cold: "Start a new session. The cache is cold: compacting now costs $1.70, a new session $0.30." |
| `unknown` | "No advice: this model has no price" (or the figure that is missing, R-16). |

Each tag says it compares **cost only**: a summary or a new session loses detail, which the product cannot measure. The figures behind it (C, P, S, F, H, prices, the three totals and the break-even points) open one level deeper, with the rule IDs (R-17, R-63). The product never compacts or starts anything itself (R-62).

### Parameters

| Key | Default | Why |
|---|---|---|
| `rules.freshSession.minSessions` | 5 | a median of fewer sessions says little |
| `rules.sessionAdvice.minCompactions` | 5 | a median of fewer compactions says little |
| `rules.sessionAdvice.minSessions` | 5 | the same for messages still to come |
- `rules.sessionAdvice.contextBandEdgesTokens` | `[50000, 100000, 200000, 500000]` | half-open context bands `[from, to)` for `REMAIN-1` and lean-context floor for `WORKFLOW-1` |
| `rules.sessionAdvice.recentTurnsWindow` | `5` | recent turns averaged for current step load in `WORKFLOW-1` |
| `rules.sessionAdvice.weights` | `{ cacheRead: 0.1, inputUncached: 1, cacheWrite: 1.25, output: 5 }` | token weights (`1` = `1` uncached input token) for per-step, active-window, session and subagent weighted load |

There are no other thresholds: the advice comes from comparing three totals.

### Worked example

Use illustrative rates of $1 for cache reads, $5 for cache writes, and $10 for output, per million tokens. Take a 200,000-token context, a 100,000-token context after compaction, a 20,000-token summary, and a 60,000-token fresh context.

- **Warm cache:** Keeping the session costs $0.20 per later message. Starting fresh costs $0.30 for the initial cache write and $0.06 per later message. Starting fresh becomes cheaper at three later messages.
- **Cold cache:** Rewriting the existing context costs $1.00. Compacting costs $1.70 to rewrite the existing context, generate the summary and write the smaller cache. Starting fresh has the lowest initial cost at $0.30.

## Alternatives considered

- **Token counts only, no prices:** works without a price table, but read, write and output tokens differ in price by up to 100 times. Without prices the advice cannot see that the summary is the expensive part, or that a cold compaction pays twice.
- **A fixed horizon from configuration (e.g. "the next 20 messages"):** simpler, but a number nobody can justify. `REMAIN-1` comes from the user's own sessions, as R-60 asks.
- **Taking the post-compaction context to be `postTokens`:** it is logged directly, but it leaves out the system prompt and tools and overstates the saving per message.
- **Modeling context growth (each message adds tokens):** more exact, but it needs a growth model per user. Leaving growth out understates the cost of keeping going, so the advice errs toward keeping going, the least disruptive choice.
- **A fourth tag "continue in a side session":** Claude Code side sessions copy the history. With a warm cache they cost about the same as keeping going and do not shrink the context, so they get no tag of their own. Their benefit, keeping side work out of the main context, is not a cost the logs show.
- **Advice for every harness now:** Antigravity logs no model and no compaction figures, so its advice is `unknown` until it does.

## VS Code compatibility

- `COMPACT-1` is part of the Claude Code adapter; `FRESH-1`, `POSTCOMPACT-1`, `SUMMARY-1`, `REMAIN-1` and `ADVICE-1` are pure functions over the normalized model with no host access (ADR 0006), and run unchanged in the extension host.
- The advice travels in the existing overview payload as plain JSON with exact decimal strings (ADR 0011); the Webview renders the tag the same way as the browser.
- The parameters live in the same configuration file and validator (ADR 0007).

## Consequences

- Open sessions get one tag with a reason in money, keep going, compact now, or start fresh.
- The cold-compaction trap becomes visible: the advice never says "compact" for a cold session when a new session is cheaper.
- The advice depends on the price table: an unpriced model gets no tag. The shipped prices (ADR 0011) cover the current Claude models.
- `SUMMARY-1` is an estimate because the summarization request is not logged; if Claude Code starts logging it, the rule uses the logged figure instead.
- ADR 0008 defines the Event's `compaction` field.
- `GET /api/overview` returns `sessionAdvice`, one `ADVICE-1` per open top-level session; the Now view shows the tag and expandable details in an "Advice" column.
