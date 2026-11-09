# agent-token-monitor

**See exactly where your AI coding agent's tokens go: live, per session, per day, per month. Computed deterministically from the logs already on your disk.**

> Status: early development. The Antigravity and Claude Code adapters, the cache analysis, pricing, session advice and a local dashboard (`Now`, `Usage`, `Cache`) are in place; report export and the Codex and OpenCode adapters are not built yet. [docs/SRS.md](docs/SRS.md) defines the product requirements. Technical decisions are recorded in [docs/adr/](docs/adr/).

---

## Why this exists

A coding agent can re-read a long session after its prompt cache expires. Compaction adds a summarization request and may require the agent to re-read files. Token counts alone do not tell you which of these happened.

**agent-token-monitor makes it visible.** It answers:

1. Which sessions are open right now, how big their context is, and whether their cache is probably cold.
2. How many tokens I used today and this month, split by harness, model and project.
3. Which session, which step and which cause (cold cache, `/compact`, model switch, random miss, oversized file read, subagent) cost the most.

## Core principles (non-negotiable)

| Principle | What it means |
|---|---|
| **Deterministic** | Same log files in, same numbers out, every time. No LLM calls, no sampling, no heuristics that change between runs. Every number traces back to a specific log line. |
| **Zero tokens** | Analysis never calls a model. Watching your usage must not cost usage. |
| **Local-only, no secrets** | Reads local log files only. **No API keys, no tokens, no credentials, no network calls, no telemetry.** Nothing leaves your machine. The repository must never contain or ask for a key. |
| **Exact or explicitly unknown** | If a log does not record a value (e.g. the hidden `/compact` summarization call in Antigravity), the tool shows it as `unknown`. It never estimates, interpolates or makes up a number. |
| **Read-only** | A pure observer. Never creates, changes, moves, locks or deletes any harness file or setting. It only reads. |
| **Harness-agnostic** | One normalized data model; each harness is a small, swappable adapter. |
| **Open source** | Built to be forked, audited and extended by adding adapters. |

## Out of scope

- **Official quota percentage.** Most harnesses do not log it, so the tool shows exact token counts instead of a made-up percent. It only reports a quota percent where the harness itself logs one (Codex does; see below), and labels it with its source.
- Your actual bill. Currency values are API list-price equivalents from a local, dated price table (SRS R-51a, R-51b).
- Changing agent behavior, auto-running `/compact`, or any control over the harness. This is an observer, not a controller.
- Reading message content beyond what is needed for classification. The dashboard and local API can show session titles, subagent descriptions, and project paths. Review screenshots and JSON output before sharing them.

## Supported harnesses (adapters)

Each adapter converts its harness's native log format into the shared model below. Initial targets, with the formats observed so far:

| Harness | Log location (macOS default) | Per-call fields available | Notes |
|---|---|---|---|
| **Antigravity** (2.0 app) | `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`, titles in `~/.gemini/antigravity/annotations/<conversation-id>.pbtxt` | `input_tokens` (uncached), `cache_read_tokens`, `output_tokens`, `created_at`, step type, tool calls | Each `PLANNER_RESPONSE` step is one request. There is no cache-write field: uncached prompt tokens are in `input_tokens`, so cache writes are recorded as `0`. The model name and thinking tokens are not logged → `unknown`. `/compact` writes a `CHECKPOINT` step with **no token counts** → shown as `unknown`. Subagents are separate conversations, linked by `.system_generated/subagents/<child-id>.json` in the parent. Other Antigravity products may write to other directories; add them to `logRoots.antigravity`. |
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, subagents in `<session-id>/subagents/agent-<id>.jsonl` | `message.usage`: `input_tokens`, `cache_creation_input_tokens` (5m / 1h split), `cache_read_input_tokens`, `output_tokens`, `thinking_tokens` | One request is written as several lines sharing a `requestId`; the adapter counts it once. Forked sessions copy earlier requests; they are counted once too. Compaction (`compact_boundary`) does not log the tokens of its summarization request → `unknown`. |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count` events: `input_tokens` (**includes** cached), `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` | Also logs `rate_limits.primary/secondary.used_percent` with window and reset time. This is the only harness that records a real quota percent. |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite, with `-wal` and `-shm` files) | not examined yet | Sessions live in a SQLite database, not in JSONL files. Opening it normally can create or change the `-wal` / `-shm` files next to it, which R-15 forbids, so the adapter must read it strictly read-only (or from a copy outside the harness directory). Its ADR decides how. |

> [!IMPORTANT]
> Field semantics differ between harnesses. For example, Codex's `input_tokens` includes cached tokens, while Antigravity's and Claude Code's do not. Adapters must normalize these explicitly, and every adapter ships with fixture-based tests that pin the conversion.

## Normalized data model

Every adapter emits the same records:

- **Session:** harness, session id, parent session (for subagents), project / working directory, model(s), first and last activity.
- **Call** (one model invocation): timestamp, session, model, `input_uncached`, `cache_read`, `cache_write`, `output`, `reasoning` (each `int` or `unknown`), the tools it called, and a context size of `input_uncached + cache_read + cache_write`.
- **Event:** compaction, model switch, user turn, subagent spawn, error.
- **Quota sample** (only where logged): source, window, used percent, reset time.

## Deterministic cache-miss classification

A call counts as a **full cache miss** when it read nothing from the cache and its context is above a configurable threshold. It counts as a **cache loss** when it is a full miss, or when it read only a small share of the previous context from the cache: every session starts with the same system prompt and tool definitions, which other sessions keep cached, so a session whose own cache expired still reads that shared beginning. Each cache loss gets exactly one cause, decided by ordered rules over the log alone ([ADR 0009](docs/adr/0009-cache-classification-lifetime-and-miss-causes.md)):

1. `modelSwitch`: the model changed since the previous call in the session.
2. `compaction`: a compaction happened since the previous call.
3. `idleBeyondLifetime`: the gap since the previous call exceeds the cache lifetime (declared by the harness, otherwise observed).
4. `prematureLoss`: everything else, including the "cache lost within seconds" case.

## Currency

Token figures are shown next to their API list-price equivalent, computed exactly from a local price table, model by model, each with its own effective date ([ADR 0011](docs/adr/0011-pricing.md)). The current Claude models ship with their published list prices; you can override or add models in your configuration file. Nothing is fetched from the network. A model without a price shows `unknown`. Currency values are list-price equivalents, not your bill: subscription and quota plans do not bill per token.

The thresholds live in one config file, and the dashboard always shows the values it used, so a run can be reproduced.

## Dashboard views (local HTML dashboard)

A single local web page that refreshes itself every few seconds and works offline.

- **Now:** open sessions (activity within N minutes) by their titles, with side sessions and subagents under the session that started them, current context size, time since last call, and cache status (`warm` / `probably cold` / `missed on last call`). Each open session also gets one piece of advice, **keep going**, **compact now** or **start fresh**, from comparing what each would cost over the messages you usually still send (`ADVICE-1`), alongside a deterministic workflow and subagent split profile (`WORKFLOW-1`: `compactActive`, `activeWorkingSet`, `explorationHeavy`, `coldLargeContext`, and `splitBreakEvenSteps`) ([ADR 0017](docs/adr/0017-session-advice.md)).
- **Usage:** totals and time series (calls, uncached input, cache read, cache write, output), broken down by harness, model and project.
- **Cache:** observed and declared lifetimes, survived and gone counts by gap band, and tokens lost to each miss cause.
- **Session drill-down:** a step-by-step token timeline, context growth, every cache miss with its cause, and the subagent tree.

Self-contained HTML report export is planned (SRS R-71, ADR 0002).

## Open decisions

Open questions are tracked in [SRS section 4](docs/SRS.md#4-open-questions); technical decisions are tracked in the [ADR index](docs/adr/README.md).

## Contributing

New harness support starts with an adapter, a few anonymized fixture log files and tests that pin the normalization.

Run the following commands from the repository root. The standalone dashboard supports macOS and requires Node.js 22.12 or newer. For other platforms or custom log locations, set the paths in your [user configuration](docs/configuration.md).

```bash
npm ci          # install the locked development tools
npm test        # builds with tsc, then runs node --test
npm start       # builds, then serves the dashboard on 127.0.0.1:4317 and prints its URL
npm run status  # prints the current overview JSON (Now + ADVICE-1 + WORKFLOW-1) to stdout and exits
```

GitHub CI runs the build and tests on macOS with the minimum supported Node.js version. It audits the npm lockfile and fails on high or critical advisories. Dependabot checks npm packages and GitHub Actions weekly. The vendored uPlot files are maintained separately from the npm lockfile.

`npm start` serves on port 4317; for another port (or `--port 0`, a free port chosen by the operating system) run `npm run build && node dist/src/hosts/node/main.js --port 8080`; `--config <path>` selects a user configuration file; `--status` prints the JSON overview and exits without starting the HTTP server. The server reads the logs read-only, writes nothing to disk and answers only requests addressed to `127.0.0.1` or `localhost` ([ADR 0013](docs/adr/0013-server-data-api-and-dashboard.md)).

Layout and boundaries are described in [ADR 0006](docs/adr/0006-project-layout-and-tooling.md); configuration keys in [docs/configuration.md](docs/configuration.md).

## License

[MIT License](LICENSE)
