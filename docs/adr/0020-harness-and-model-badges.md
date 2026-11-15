# 0020. Harness and model badges

- Status: Accepted
- Date: 2026-11-15
- Requirements: R-04, R-14, R-20, R-25, R-26, R-30, R-31

## Context

Harnesses (`claudeCode`, `antigravity`, `codex`, `opencode`) and models are currently displayed as plain text labels, with harness series colors (`--series-1` through `--series-4`) used in usage charts. Adding small visual badges alongside harness and model names improves scannability across session lists, live cards, and usage breakdowns.

Bundling third-party vendor logos (even via icon packs or Wikimedia Commons) introduces trademark and brand-guideline obligations, complicates open-source licensing and VS Code Marketplace distribution, and still requires local bundling under R-14.

## Decision

- Use **self-authored inline SVG monogram/geometric badges** rather than third-party vendor logos.
- **Harnesses:** Render a small rounded-square inline SVG badge (`aria-hidden="true"` when paired with the harness name) keyed by harness ID, reusing the existing harness series CSS variables:
  - `claudeCode`: `CC` (`--series-1`)
  - `antigravity`: `AG` (`--series-2`)
  - `codex`: `CX` (`--series-3`)
  - `opencode`: `OC` (`--series-4`)
  - Unknown/future harness: neutral fallback monogram derived deterministically from the ID.
- **Models:** Render a visually distinct, subtle outline/pill inline SVG badge keyed deterministically by normalized model-family prefix (e.g., `claude` -> `CL`, `gpt` / `o1` / `o3` / `o4` -> `GP`, `gemini` -> `GM`, and a neutral fallback for other or unknown models). Keep model badges muted (`currentColor` / border-based) so rows displaying both a harness and its native model remain calm and uncluttered (R-30, R-31).
- **Theme and offline support:** Inline SVGs rely solely on CSS variables and `currentColor` so they adapt to Bootstrap light/dark modes (ADR 0019) with zero network calls (R-14) and zero new dependencies.

## Alternatives considered

1. **Vendor logos (official brand kits, Wikimedia Commons, `simple-icons`, `@lobehub/icons`):** Increases trademark and brand-guideline compliance overhead (including non-modification rules and Marketplace notices) without improving core telemetry clarity.
2. **Text-only labels:** Zero asset maintenance, but slower visual scanning in multi-harness lists and model tables.

## VS Code compatibility

Inline `<svg>` elements rendered by the existing DOM helpers require no external asset URIs, work under strict VS Code Webview Content Security Policies without `img-src` exceptions, make no network requests (R-14), and inherit VS Code light, dark, and high-contrast theme variables (R-25, R-26).

## Consequences

- Zero third-party trademark, copyright, or dependency risk.
- Adding a new harness or model family requires only updating the deterministic badge mapping in the frontend helper, with safe fallbacks for unmapped values.
