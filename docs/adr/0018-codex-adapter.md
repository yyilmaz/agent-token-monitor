# 0018. Codex rollout adapter

- Status: Accepted
- Date: 2026-11-09
- Requirements: R-10, R-14, R-15, R-16, R-17, R-18, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-32, R-33, R-70, R-72

## Context

Phase 2 adds Codex to the dashboard. Codex stores local transcripts as rollout JSONL files. A rollout can contain both request-level `token_usage_record` entries and `event_msg.token_count` snapshots that repeat the same usage. Older rollouts can contain only snapshots. Counting both would inflate usage.

## Decision

Use the existing configured Codex log roots and rollout filename pattern. The default root is `~/.codex/sessions`. Users can add archived sessions or a custom Codex home through `logRoots.codex`. Discover and read files through the existing read-only host and incremental store (ADR 0014).

- **COD-1:** Use `session_meta.id` as the native thread ID, `cwd` as the project, and the logged parent thread ID when present. Associate calls with the applicable `turn_context.model` when available. Retain only fields needed by the normalized model, including source line references.
- **COD-2:** Use `token_usage_record.usage` for request-level counts and deduplicate by response ID within a thread. When a following `token_count` snapshot repeats that request's usage, treat it as another source for the same call. For older or mixed logs, use unmatched `last_token_usage` only when `total_token_usage` advances in file order. An initial snapshot without a request record is eligible if it has valid last usage and nonzero cumulative usage. Repeated totals and quota-only snapshots add no calls. Cumulative values are used for comparison only. Legacy calls use thread ID and cumulative usage for a stable identity.
- **COD-3:** Normalize uncached input as `input_tokens - cached_input_tokens` per ADR 0008. Map cache reads, cache writes, output and reasoning from their logged fields. Missing or inconsistent counts stay unknown. Emit compaction and user-turn events from explicit markers and map logged primary and secondary quota windows to quota samples, converting minutes to seconds and reset times to epoch milliseconds.
- **COD-4:** Return fixed diagnostic messages for malformed JSON or unsupported usage records without exposing log content. Anonymized fixtures cover mixed and legacy rollouts, duplicate requests, quota-only snapshots, missing values, and the equivalence of direct parsing and incremental combining. A host test verifies discovery and dashboard usage through the normal entry point.

## Alternatives considered

- Read only cumulative usage snapshots. This loses request identities available in newer transcripts and makes duplicate detection harder.
- Query the Codex app server or state database. That introduces a second integration surface for data already present in the rollouts.

## VS Code compatibility

The adapter uses pure TypeScript and the two-step contract from ADR 0014. The extension host can supply files through its own read-only file source and send the normalized results to the existing Webview. No additional runtime or dependencies are required.

## Consequences

Codex token usage flows through the existing usage and cache analyses. The normalized model retains logged quota windows with source references. Legacy snapshots can provide usage only where the log supplies enough information to distinguish requests.
