# 0011. Pricing: local price table and exact currency arithmetic

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-14, R-16, R-17, R-26, R-51a, R-51b, R-63, R-71, R-72

## Context

R-51a requires usage figures and session advice to be shown in tokens and in currency, side by side, from Phase 1 onward. Prices come from a local, user-editable price table that is never fetched from the network (R-14). Every price table states its effective date, and the dashboard shows it. A model with no configured price shows its currency value as `unknown` (R-16). R-51b requires currency to be labeled as an API list-price equivalent, not the user's bill. ADR 0007 puts the price table in the `pricing` section of the one configuration file and leaves its shape and arithmetic to this ADR.

Three facts shape the decision:

- **Prices are per million tokens and have fractional cents** (e.g. 0.30 per million). Binary floating point cannot add such values exactly, and R-71 requires byte-identical reports.
- **Some providers price by context size.** A call above a context threshold pays a higher price for all its tokens. A single rate cannot represent both pricing tiers.
- **A write lifetime may have no listed price** in the price table.

## Decision

All rules are pure functions in `src/core/pricing/` over Call records (ADR 0008). Models are effective models (ADR 0009 `MODEL-1`).

### Price table

```json
{
  "pricing": {
    "currency": "USD",
    "displayDecimals": 2,
    "models": {
      "example-model": {
        "effectiveDate": "2026-10-01",
        "tiers": [
          {
            "minContextTokens": 0,
            "inputPerMillionTokens": 3,
            "outputPerMillionTokens": 15,
            "cacheReadPerMillionTokens": 0.3,
            "cacheWritePerMillionTokensByTtlSeconds": { "300": 3.75, "3600": 6 }
          },
          {
            "minContextTokens": 200001,
            "inputPerMillionTokens": 6,
            "outputPerMillionTokens": 22.5,
            "cacheReadPerMillionTokens": 0.6,
            "cacheWritePerMillionTokensByTtlSeconds": { "300": 7.5, "3600": 12 }
          }
        ]
      }
    }
  }
}
```

- `currency` is an ISO 4217 code (three capital letters). It is a label only; there is no conversion.
- Prices are keyed by model name. A model is priced the same in every harness.
- **Each model states its own `effectiveDate`** (`YYYY-MM-DD`), so the user can update one model without re-dating the others. The dashboard and exported reports show it next to every currency figure of that model.
- **Announced price changes** go in an optional `changes` list on the model: `[{ "effectiveDate": "2026-12-01", "tiers": [...] }]`, with the same tier rules and dates strictly later than the one before. A call pays the prices in force on the UTC date of its timestamp: the last period whose `effectiveDate` is on or before it. A call before the first `effectiveDate` pays the first prices, the earliest ones known. A hypothetical step that happens now (session advice, ADR 0017) uses the prices in force at the "as of" time. History therefore keeps the price it was used at when a provider raises or lowers one, and a change announced in advance takes effect on its day without anyone editing the file.
- `tiers` is non-empty, ordered by strictly ascending `minContextTokens`, and the first tier starts at `0`. A call pays the prices of the last tier whose `minContextTokens` is at most its context size (`inputUncached + cacheRead + cacheWrite`), for all its tokens.
- Prices are numbers with at most 6 decimal places. Write prices are keyed by lifetime in seconds; the table may be empty for a model that has no cache-write category.
- Reasoning tokens are part of `output` (ADR 0008) and are priced as output.
- **The product ships the published list prices of the Claude models supported by the pricing table** (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, and `gemini-4-argon` for Antigravity), copied by hand from [Anthropic's](https://platform.claude.com/docs/en/about-claude/pricing) and [Google's](https://ai.google.dev/gemini-api/docs/pricing) pricing pages and dated with the day they were checked. Nothing is fetched at run time (R-14). A model not in the table shows `unknown` until the user adds it; the user file overrides any shipped model key by key (ADR 0007). `docs/configuration.md` lists the shipped prices and their source.

### Exact arithmetic

**Rule `PRICE-1`.** On load, every price is converted to an integer number of millionths of the currency per million tokens: `round(price × 1,000,000)`. A price for which this is not exact is a configuration error. The cost of `n` tokens is the integer `n × price in millionths`, in units of 10⁻¹² of the currency, computed with `BigInt` so no value ever overflows.

- Sums are exact integers. Results leave the core as decimal strings with 12 decimal places (e.g. `"12.345678000000"`), because JSON numbers cannot carry them exactly.
- Rounding happens only for display: half to even, to `displayDecimals` places. Totals are rounded once, after summing, never summed from rounded parts.

### Cost of one call

**Rule `PRICE-2`.** For a Call:

- `inputUncached × input + cacheRead × cacheRead + Σ (writes of each lifetime × write price of that lifetime) + output × output`, each part reported separately, with its total.
- The **write price of a lifetime** is the listed price for that lifetime. When none is listed, the price of the shortest listed lifetime longer than it is used; when there is none, the longest listed lifetime. The result names the lifetime whose price was used.

A call's cost is `unknown`, with its reason, when:

- its model is unknown or has no entry in the table (`unpricedModel`);
- one of its token counts is unknown (`unknownTokens`);
- it has cache writes and the table lists no write price for its model, or the log does not say which lifetime the writes had (`unknownWritePrice`).

Compaction calls with no token counts are therefore `unknown`.

### Totals

A total over many calls (a day, a month or a session) is the exact sum of the calls whose cost is known, together with the number of calls whose cost is `unknown`, by reason. When that number is not zero, the total is labeled "incomplete: N calls without a price" and is never shown as if it covered every call (R-16).

### Labels

Every currency figure carries:

- the label **"API list-price equivalent, not your bill. Subscription and quota plans do not bill per token."** (R-51b);
- the currency and the effective dates of the prices it used, per model;
- rule `PRICE-2` and, where a write price came from another lifetime, that lifetime (R-63).

Each call's cost links to its Call, and through it to the log lines (R-17).

### Parameters

| Key | Default |
|---|---|
| `pricing.currency` | `"USD"` |
| `pricing.displayDecimals` | `2` |
| `pricing.models.<model>` | the shipped list prices above |

## Alternatives considered

- **JSON numbers used as floating point:** simple, but sums depend on the order of addition and reports would not be byte-identical (R-71).
- **Prices as decimal strings in the configuration:** exact without the 6-decimal limit, but unusual to edit. Six decimal places per million tokens are far finer than any published price.
- **Cache prices as multipliers of the input price** (e.g. read `0.1×`, 1-hour write `2×`): matches how some providers describe them, but not all providers use the same multipliers, and absolute prices are what providers publish. A multiplier is the ratio of two listed prices, so the table still carries it.
- **One price per model, no context tiers:** simpler, but wrong for calls in a different context tier.
- **An empty price table, filled only by the user:** never looks authoritative, but every currency figure is `unknown` until the user finds and types the prices. The shipped table carries each model's effective date and source instead, so a stale price is visible.
- **A cost of `unknown` for a write lifetime with no listed price:** strictly safe, but loses the currency value when a write lifetime is not in the table. The nearest-longer-lifetime rule is fixed and labeled.
- **One price per model, edited when it changes:** simpler, but a change re-prices all history, and a change announced in advance has to be typed in on its day. Dated `changes` keep both right.
- **Pricing calls by their date in `usage.timeZone`:** matches the day boundaries of the Usage view, but providers announce changes by calendar day without a time zone, and the UTC date makes a price independent of a setting.
- **Cache storage prices per hour** (offered by some providers for explicit caches): not observable in the logs of implicit caching, so not modeled.

## VS Code compatibility

- `PRICE-1` and `PRICE-2` are pure functions in `src/core/pricing/` with no host access (ADR 0006). `BigInt` is available in every Node.js version the extension host runs and in every Webview.
- The price table lives in the same configuration file and is validated by the same core validator (ADR 0007); the extension edits it as JSON.
- Costs are plain JSON with decimal strings (ADR 0008), rendered the same way in the Webview and the browser.

## Consequences

- Currency figures are exact and reproducible to the last digit; only display rounds.
- Until the user enters prices, currency values show `unknown`; token figures are unaffected.
- Prices are maintained by the user, model by model, each with its own date. The shipped table carries `gemini-4-argon`'s announced 2026-12-01 increase as a dated change.
