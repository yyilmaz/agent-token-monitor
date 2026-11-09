# 0009. Cache classification, observed lifetime and miss causes

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-11, R-16, R-17, R-18, R-26, R-40, R-41, R-42, R-43, R-44, R-72

## Context

The SRS requires, for every call, a hit / partial / full-miss classification with the tokens re-read without a cache hit (R-40). It also requires the idle gaps after which the cache survived or was gone (R-41), an observed lifetime computed with a fixed, documented interval method (R-42), one cause per full miss from an ordered rule set (R-43), and comparing declared cache lifetimes with observed ones (R-44).

Logs never record when a cache entry is evicted. They only show, at each call, whether the cache was still there. The method must therefore be honest about what can be inferred, and fully deterministic (R-10, R-11).

Two facts about real logs shape the rules:

- **Some harnesses do not log the model.** Antigravity records no model name for any call. Without a model, no call can be grouped, and no lifetime can be observed for that harness.
- **The beginning of every prompt is shared.** A provider's cache is keyed by prompt content, not by session, and all sessions start with the same system prompt and tool definitions (tens of thousands of tokens). Other sessions keep this shared beginning cached. When a session's own cache expires, its next call still reads the shared beginning from cache, so the loss shows up as a partial hit with a small read share, not as a full miss.

## Decision

All rules below are pure functions in `src/core/analysis/` over the model of ADR 0008. Each has a stable rule ID, shown next to every result it produces (R-17). Every parameter lives in the `cache` section of the configuration, except the assumed models of `MODEL-1`, which live in `models` (ADR 0007, R-72).

### Effective model

**Rule `MODEL-1`.** A call's effective model is its logged `model`. When the log has none (`null`) and `models.assumed.<harness>` is set in the configuration, the effective model is that configured name. Every result that uses a model states its source: `logged`, `assumed` or none (R-16). The adapter output is not changed: the Call keeps `model: null`.

All rules below that mention a call's model mean its effective model. The user sets the assumed model when they always use the same one. If they sometimes switch models, the calls made with another model are attributed to the assumed one; the dashboard says so next to every result marked `assumed`. Where a harness names the effort level as part of the model choice (for example a "high" and a "low" variant), the variant is written into the name.

### Pairs

**Rule `PAIR-1`.** Analysis looks at consecutive **turn** Calls of the same session in canonical order. Compaction Calls carry no tokens and are not paired: like compaction events, they lie between the two calls of a pair. For each turn Call `c` with a predecessor `p`:

- `gapSeconds = (c.timestamp − p.timestamp) / 1000`, a derived value. Recorded timestamps are close to, but not exactly, the moment the cache was last refreshed. This imprecision is documented next to every gap.
- `prefixTokens = contextSize(p)`: what `p` had in its context, and therefore what `c` could have read from the cache.

The first Call of a session has no pair.

### Classification of each call (R-40)

**Rule `CLS-1`**, in this order:

| Class | Condition |
|---|---|
| `unknown` | `cacheRead` or `contextSize` of `c` is `null` |
| `first` | `c` has no predecessor |
| `belowThreshold` | `cacheRead = 0` and `contextSize(c) < fullMissMinContextTokens` |
| `fullMiss` | `cacheRead = 0` |
| `hit` | `reReadTokens ≤ hitToleranceTokens` |
| `partial` | everything else |

`reReadTokens = max(0, min(prefixTokens, contextSize(c)) − cacheRead)`: tokens that were in the previous context but had to be re-read without a cache hit. It is reported for every classified call (R-40). When `prefixTokens` is `null`, `reReadTokens` is `null` and only `unknown`, `first`, `belowThreshold` and `fullMiss` can apply.

**Rule `LOSS-1`.** A call is a **cache loss** when it is `fullMiss`, or when it is `partial` and `cacheRead < survivedMinCacheReadShare × prefixTokens`: the session's own cache was gone and only a shared beginning was read. Every result says whether a call is a cache loss, next to its class.

### Survival observations (R-41)

**Rule `OBS-1`.** A pair is a survival observation when all of these hold:

1. `c` is `hit`, `partial` or `fullMiss`;
2. both calls have the same known model;
3. no compaction event or compaction call lies between them.

- A cache loss (`LOSS-1`) means the cache was **gone** after `gapSeconds`.
- Any other `hit` or `partial` means the cache **survived** a gap of `gapSeconds`.

Observations are grouped by harness, model and declared lifetime (`DECL-1`), and by session. The dashboard shows survived and gone counts per gap band. The band edges are `lifetimeBandEdgesSeconds`.

Assumption, documented with the result: each call refreshes its cache entry, so the gap since the previous call is the time the entry had to survive.

### Observed lifetime (R-42)

**Rule `LIFE-1`**, per harness, model and declared lifetime (`DECL-1`, with "none declared" as a group of its own). A harness can promise different lifetimes for the same model: Claude Code gives the main session a one-hour cache and its subagents a five-minute one. Pooled, the two would blur into one median that matches neither promise, so each is measured on its own. All figures are labeled **derived** with this rule ID (R-16).

- **Longest survived gap:** the largest `gapSeconds` among survived observations.
- **Shortest gone gap:** the smallest `gapSeconds` among gone observations.
- **Lifetime distribution:** each observation is interval-censored: a survived gap `g` says the lifetime was longer than `g`, and a gone gap says it was at most `g`. The distribution `F(g) = P(lifetime ≤ g)` is estimated with the standard nonparametric maximum-likelihood estimator for this kind of data:
  1. put observations with the same `gapSeconds` into one block, whose value is its gone count divided by its observation count;
  2. order the blocks by `gapSeconds`;
  3. apply isotonic regression (pool adjacent violators, weighted by observation count) to make the values non-decreasing.

  The result is the estimated `F` at each distinct observed gap. Because tied observations start in one block, the result does not depend on their order. It is computed with exact rational arithmetic (integer numerators and denominators) to avoid floating-point drift, and converted to decimals only for display.
- **Typical lifetime (median):** the smallest observed gap where `F ≥ 1/2`.
- If a group has fewer than `minLifetimeObservations` observations, or has no survived or no gone observation, the lifetime is shown as "insufficient data" instead of a number.

### Declared lifetime (R-44)

**Rule `DECL-1`.** A call's declared lifetime is:

1. the largest lifetime with non-zero tokens in `cacheWriteByTtlSeconds` of the most recent call in the session that wrote cache, when the harness logs it (Claude Code: 300 s or 3600 s); otherwise
2. `declaredLifetimeSeconds` for that harness and model from configuration, if set; otherwise
3. none.

### Miss causes (R-43)

**Rule `CAUSE-1`.** Each cache loss (`LOSS-1`), and so every `fullMiss`, gets exactly one cause. The first matching rule wins:

| Order | Cause | Condition |
|---|---|---|
| 1 | `modelSwitch` | `p` and `c` have different known models |
| 2 | `compaction` | a compaction event or compaction call lies between `p` and `c` |
| 3 | `idleBeyondLifetime` | `gapSeconds` > reference lifetime |
| 4 | `prematureLoss` | everything else |

The reference lifetime is the declared lifetime (`DECL-1`) when there is one. Otherwise it is the observed median (`LIFE-1`) of the pairs of that harness and model with no declared lifetime. If neither exists, it is `referenceLifetimeSeconds` from configuration for that harness. The result always names which of the three was used.

### Parameters

All in `cache` in `config/default.json`. Initial defaults below are starting points to be tuned against real usage; changing them changes only configuration.

| Key | Proposed default |
|---|---|
| `fullMissMinContextTokens` | 20000 |
| `survivedMinCacheReadShare` | 0.75 |
| `hitToleranceTokens` | 1024 |
| `lifetimeBandEdgesSeconds` | [60, 300, 900, 1800, 3600, 7200, 21600, 86400] |
| `minLifetimeObservations` | 20 |
| `declaredLifetimeSeconds` | per harness and model, empty by default |
| `referenceLifetimeSeconds` | per harness: Claude Code 300, Antigravity 300, Codex 300, OpenCode 300 |
| `models.assumed` (section `models`) | per harness, empty by default |

## Alternatives considered

- **Midpoint or simple averages of gaps as "lifetime":** easy to compute, but statistically wrong for censored data and easy to misread.
- **One lifetime per harness and model, whatever was promised:** fewer groups, but combining one-hour and five-minute caches hides the difference between their lifetimes. Splitting by `DECL-1` costs more groups, some of them "insufficient data".
- **Parametric fits (for example exponential or Weibull):** smoother, but assume a shape that cache eviction does not follow, and fitting needs iterative numerics that are harder to keep byte-identical.
- **Observed lifetime as the reference for `idleBeyondLifetime` even when a lifetime is declared:** follows the literal wording of R-43, but then a provider that promises one hour and drops the cache after five minutes would have its losses blamed on the user's idle time. Using the declared lifetime first keeps those losses visible as `prematureLoss`.
- **Counting a partial hit as a miss:** would hide that part of the cache survived. Partial hits are reported separately with their re-read tokens.
- **Treating an unlogged model as one shared model per session, without asking the user:** gives Antigravity a lifetime with no configuration, but no model name, so the group cannot be attributed to a model. A configured name identifies the assumed model.
- **Counting every partial hit as survived:** simple, but a session whose own cache expired still reads the shared beginning, so its loss counts as survival.
- **Excluding gaps in which another session called the same model:** discards observations while retaining some long-gap partial hits, because the shared beginning stayed cached anyway.
- **Calling every partial hit with a large re-read a full miss in `CLS-1`:** would hide that part of the cache survived, and change the meaning of `fullMiss`. `LOSS-1` keeps the class and adds the loss judgment next to it.

## VS Code compatibility

- Every rule is a pure function in `src/core/analysis/` with no clock, filesystem or host access (ADR 0006). The extension runs exactly the same code.
- The algorithms run in O(n log n) per group. If large histories ever slow the VS Code extension host, the VS Code host can run the same analysis in a `node:worker_threads` worker. This is a host change only.
- Results are plain JSON (ADR 0008), so the Webview renders them the same way as the browser.

## Consequences

- Every cache number on screen has a rule ID, its thresholds and the pairs behind it.
- Lifetimes are reported as derived estimates with a clear "insufficient data" state, never as made-up precision.
- Old classifications can change when more history arrives, because the observed median feeds `CAUSE-1`. The result is still deterministic for the same logs, configuration and "as of" time (R-10).
- R-43 ("idle beyond the observed lifetime") is read as: the declared lifetime takes precedence when one exists, the observed lifetime otherwise.
- Exact rational arithmetic in `LIFE-1` costs a little more code than floating point, in exchange for byte-identical results.
- Expired caches are counted as losses even when a shared beginning survived, so lifetimes and miss causes reflect each session's own history. The share that separates a loss from a survival is a tunable parameter (`survivedMinCacheReadShare`).
- The Cache view shows one lifetime card per harness, model and promised lifetime, so "promised 1 h" and "promised 5 min" are compared with what each actually lasted.
- A harness that does not log its model gets lifetimes and model-based results only after the user sets `models.assumed`, and those results are labeled `assumed`.
