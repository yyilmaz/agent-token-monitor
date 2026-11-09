# Architecture Decision Records

This folder records every significant technical decision made to satisfy the [SRS](../SRS.md), in the format introduced by Michael Nygard.

## Rules

- One decision per file, named `NNNN-short-title.md` (e.g. `0002-implementation-language.md`). Numbers are sequential and never reused.
- An ADR MUST cite the SRS requirement IDs (`R-xx`) it serves. A decision that conflicts with the SRS is invalid: the SRS must be amended first.
- An ADR MUST state how the decision works inside the future VS Code extension (R-26), in its "VS Code compatibility" section.
- **The folder holds only current decisions.** To change a decision, revise its ADR. A decision that no longer applies is deleted. Git history is the archive; no `Superseded`, `Deprecated` or "previously" notes are kept.
- Status values: `Proposed`, `Accepted`.

## Template

```markdown
# NNNN. Title

- Status: Proposed
- Date: YYYY-MM-DD
- Requirements: R-xx, R-yy

## Context
What problem or force requires a decision?

## Decision
What we decided, stated plainly.

## Alternatives considered
Each option and why it was not chosen.

## VS Code compatibility
How the decision works inside the future VS Code extension (SRS R-25, R-26). Required: an ADR without this section is not accepted.

## Consequences
What becomes easier, harder or constrained as a result.
```

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-frontend-backend-architecture.md) | Plain frontend-backend architecture on localhost | Accepted |
| [0004](0004-backend-language-typescript.md) | Backend language: TypeScript on Node.js, zero runtime dependencies | Accepted |
| [0005](0005-frontend-single-page-typescript.md) | Frontend: single HTML page, plain TypeScript, vendored uPlot, polling | Accepted |
| [0006](0006-project-layout-and-tooling.md) | Project layout, module system and tooling | Accepted |
| [0007](0007-configuration-file.md) | Configuration file: strict JSON, shipped defaults plus one user override | Accepted |
| [0008](0008-normalized-data-model.md) | Normalized data model | Accepted |
| [0009](0009-cache-classification-lifetime-and-miss-causes.md) | Cache classification, observed lifetime and miss causes | Accepted |
| [0011](0011-pricing.md) | Pricing: local price table and exact currency arithmetic | Accepted |
| [0013](0013-server-data-api-and-dashboard.md) | Local server, data API and dashboard views | Accepted |
| [0014](0014-incremental-log-reading.md) | Incremental log reading | Accepted |
| [0016](0016-session-titles-and-tree.md) | Session titles and session tree | Accepted |
| [0017](0017-session-advice.md) | Session advice: keep going, compact or start fresh | Accepted |
