# Software Requirements Specification (SRS)

**Product:** agent-token-monitor (working title)
**Status:** Draft, requirements phase
**Owner:** Project owner (sole authority over this document)

---

## 1. Introduction

### 1.1 Purpose

This document specifies the binding requirements for agent-token-monitor. It is the highest authority in the repository: the README, architecture decision records (ADRs), code and tests must conform to it. A release that violates any `MUST` or `MUST NOT` requirement is not shippable.

### 1.2 Scope

agent-token-monitor is a local, open-source tool. It reads the logs that AI coding agent harnesses already write to disk and shows where tokens go, how prompt caches behave, and how to reduce waste. It does this deterministically and without consuming tokens.

### 1.3 Conventions

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals.

Every requirement has a stable ID (`R-xx`). IDs are never reused or renumbered. Tests, issues, ADRs and code cite these IDs.

### 1.4 Definitions

| Term | Meaning |
|---|---|
| **Harness** | An AI coding agent product that writes local session logs (Antigravity, Claude Code, Codex, OpenCode). |
| **Adapter** | The component that converts one harness's native logs into the normalized model. |
| **Call** | One model invocation recorded in a log. |
| **Context size** | Uncached input + cache read + cache write tokens of a call. |
| **Full miss** | A call with zero cache-read tokens and a context size above the configured threshold. |
| **TTL** | The lifetime of a prompt-cache entry. |
| **Derived value** | A value computed by a documented rule rather than read directly from a log. |

### 1.5 Change control

Requirements change only by explicit owner decision. This document always states the current requirements only; earlier versions live in git history, not in the document. The technical decisions made to satisfy these requirements are recorded as ADRs in [`docs/adr/`](adr/).

---

## 2. Overall description

### 2.1 Product purpose

- **R-01** The product MUST show a developer exactly where the tokens of their AI coding agents go, MUST explain why (with particular depth on prompt-cache behavior), and MUST give deterministic, actionable advice to reduce waste.

### 2.2 Product boundaries

- **R-02** The product MUST be an observer only. It MUST NOT change agent behavior, send prompts, or edit harness settings or files.
- **R-03** The product MUST be open source under the MIT License (see `LICENSE`), with the copyright held by Yusuf Yılmaz. It SHOULD be easy to fork, audit and extend.
- **R-04** All product documentation (README, this SRS, ADRs, design docs, code comments, identifiers, commit messages, UI text, alerts and recommendations) MUST be written in English.

---

## 3. Requirements

### 3.1 Absolute principles

- **R-10 Determinism.** The same input logs, configuration and "as of" timestamp MUST produce byte-identical numbers, classifications, alerts and recommendations. Wall-clock time MUST be treated as an explicit input.
- **R-11 No AI decisions.** No metric, classification, alert or recommendation MAY be produced, ranked or phrased by a language model or any other non-deterministic method. Every output MUST come from fixed, documented rules.
- **R-12 Zero tokens.** Using the product MUST NOT consume model tokens.
- **R-13 No secrets.** The repository MUST NOT contain, request or store API keys, tokens, passwords or credentials. No feature MAY require one.
- **R-14 Local only.** All data MUST stay on the user's machine. The product MUST NOT make network calls or collect telemetry, and MUST serve its interface on localhost only.
- **R-15 Read-only toward harnesses.** The product is a read-only observer. Harness directories (e.g. `~/.claude`, `~/.gemini`, `~/.codex`, `~/.local/share/opencode`, every configured log root and the harness applications) are off limits for any write: the product MUST NOT create, modify, move, rename, truncate, lock or delete anything inside them, for any reason, including files of its own that have nothing to do with the harness (no caches, temporary files, configuration or reports). It MUST NOT change any harness setting. It only reads. This applies equally to development, tests and tooling of this project.
- **R-16 Exact or explicitly unknown.** A value the logs do not record MUST be shown as `unknown` and MUST NOT be estimated or filled in. Derived values MUST be labeled as derived, together with the rule that produced them.
- **R-17 Traceability.** Every displayed number MUST be traceable to the log lines and the rule that produced it.
- **R-18 Privacy by default.** Prompt text, code and file contents MUST NOT be displayed, stored or exported. The product SHOULD read only what classification requires.

### 3.2 Harness support

- **R-20** The product MUST support **Antigravity**, **Claude Code**, **Codex** and **OpenCode**.
- **R-21** Phase 1 MUST deliver Antigravity and Claude Code. Codex and OpenCode MUST follow in Phase 2. The architecture MUST support them and further harnesses from Phase 1 onward.
- **R-22** Each harness MUST be implemented as an independent adapter that emits one shared, normalized model. Harness-specific field semantics (e.g. whether `input_tokens` includes cached tokens) MUST be resolved only inside the adapter and MUST be pinned by fixture tests.
- **R-23** If an adapter cannot read or understand a log, it MUST report this visibly and MUST NOT skip the log silently.
- **R-24 Platforms.** Phase 1 MUST support macOS. Linux and Windows MAY follow in later phases. Log locations MUST be configurable and MUST NOT be hardcoded to macOS paths, so other platforms can be added without restructuring (R-72).
- **R-25 VS Code extension (long-term goal).** The product SHOULD eventually ship as a VS Code extension, and MAY also target VS Code-based editors (e.g. Antigravity, Cursor) through Open VSX. From Phase 1 onward, the architecture MUST stay compatible with this goal: analysis and adapters MUST NOT depend on the standalone server, and the UI MUST be reusable inside a VS Code Webview. All other requirements, including R-14 (local only), apply equally to the extension.
- **R-26 Every decision stays VS Code-native.** Every technical decision (ADR) and every implementation MUST keep the product shippable as a native VS Code extension (R-25) without rewriting adapters, analysis or UI. In particular:
  1. Code MUST use only what the VS Code extension host (the Node.js runtime bundled with VS Code) and a VS Code Webview provide. It MUST NOT require native binary modules, a separate runtime (e.g. Python) or any other globally installed tool.
  2. Host-specific concerns (serving HTTP, watching files, locating and loading configuration, reading the clock, opening the UI) MUST sit behind narrow interfaces with replaceable host implementations. The standalone server and the VS Code extension are two such hosts.
  3. UI code MUST work under VS Code Webview constraints: a strict Content Security Policy, no inline scripts or handlers, assets by relative path, and data access through one replaceable layer (ADR 0005).
  4. Inside VS Code, the UI SHOULD follow the active editor theme (light, dark, high contrast) instead of a fixed palette.
  5. Every ADR MUST contain a "VS Code compatibility" section stating how the decision works inside the extension. An ADR without it MUST NOT be accepted.

### 3.3 User interface

- **R-30** The interface MUST be simple enough that a developer understands their situation within seconds of opening it. Details SHOULD sit one level deeper and MUST NOT clutter the main screen.
- **R-31** The product MUST provide one local dashboard with a calm visual hierarchy.
- **R-32** The dashboard MUST update itself continuously while open, without manual reload.
- **R-33** The dashboard MUST provide these views:
  1. **Open sessions now:** each active session with its harness, context size, time since the last call, live cache status and session advice.
  2. **Usage by day, month and session**, broken down by harness, model and project.
  3. **Cache behavior** (section 3.4).

### 3.4 Cache observation

- **R-40** For every call, the product MUST record whether the cache hit fully, partially or missed fully, and how many tokens were re-read at full price as a result.
- **R-41** For each harness, model and session, the product MUST show the idle gaps after which the cache survived and the gaps after which it was gone.
- **R-42** The product MUST report the observed cache lifetime in seconds, at minimum:
  - the longest idle gap after which the cache still hit,
  - the shortest idle gap after which the cache had been dropped,
  - the typical lifetime (median and distribution).

  Because logs never record the exact moment of eviction, lifetime figures MUST be computed with a fixed, documented interval method and MUST be labeled as derived (R-16).
- **R-43** Every full miss MUST be assigned exactly one cause from a fixed, ordered rule set covering at minimum: model switch, compaction, idle beyond the observed lifetime, and premature loss.
- **R-44** Where a harness declares or implies a cache lifetime (e.g. Claude Code logs 5-minute and 1-hour cache writes), the product MUST compare it with the observed lifetime.

### 3.5 Currency

- **R-51a Tokens and currency together.** From Phase 1 onward, usage figures and session advice MUST be shown in both token units and currency, side by side. Prices MUST come from a local, user-editable price table (never fetched from the network, R-14). The product MAY ship a default price table; every price table MUST state its effective date, and the dashboard MUST show it. A model with no configured price MUST show its currency value as `unknown` (R-16).
- **R-51b Currency is list-price equivalent.** Currency values MUST be labeled as API list-price equivalents, not as the user's actual bill. Subscription and quota plans (e.g. Antigravity) do not bill per token, so the label MUST make this clear.

### 3.6 Session advice

- **R-60** The product MUST give concrete advice to reduce token waste for open sessions. Each recommendation MUST come from a fixed rule with documented parameters, MUST show the data that triggered it, and MUST show the expected saving computed from the user's own history.
- **R-62** Recommendations MUST tell the user what to do (e.g. keep going, compact now, or start a new session). The product MUST NOT act on them (R-02).
- **R-63** Every recommendation MUST show its rule ID, the parameters used and a link to the evidence (R-17).

### 3.7 Quality

- **R-70** Every adapter MUST ship with anonymized fixture logs and tests that pin its normalization and cache classification.
- **R-71** An exported report MUST be regenerable byte-identically from the same logs, configuration and "as of" time. Reports show project names, paths and session titles as recorded; nothing is shortened or anonymized.
- **R-72** All thresholds, multipliers and paths MUST live in one documented configuration file. Code MUST NOT contain magic numbers.

---

## 4. Open questions

To be resolved by the owner. A resolved question is removed from this list and turned into requirements.

- **Q-3** Project name (`agent-token-monitor` is a working title).
