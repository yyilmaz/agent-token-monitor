# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-03, R-04, R-17

## Context

The product is open source and governed by a binding SRS. Contributors need to know not only what the system does but why each technical choice was made, and which requirement it serves.

## Decision

Requirements live in `docs/SRS.md`. Technical decisions live in `docs/adr/` as Architecture Decision Records, one decision per file, using the template and rules in `docs/adr/README.md`.

## Alternatives considered

- **Decisions inside the SRS:** mixes "what" with "how" and makes requirements harder to keep stable.
- **Decisions in issues or chat only:** not versioned with the code and easy to lose.

## Consequences

- Every significant technical choice (language, packaging, cache-lifetime method, dashboard technology) requires an ADR before implementation.
- Reviewers can reject code that implements an undocumented decision.
