# Contributing

Thanks for helping. This project is a deterministic, local, read-only observer of AI coding agent logs. Contributions must keep it that way.

## Ground rules

- [docs/SRS.md](docs/SRS.md) is the product contract. Accepted ADRs in [docs/adr/](docs/adr/) record the technical decisions. When they conflict with a change, the SRS wins, then the ADRs. Only the maintainer changes the SRS: open an issue to propose a change.
- A significant technical decision (language, library, data format, algorithm with tunable parameters, UI technology) starts as a `Proposed` ADR, written with [docs/adr/README.md](docs/adr/README.md). Do not implement it before it is accepted.
- Every decision must keep the product shippable as a native VS Code extension (R-26).
- Open an issue before a large change or a new dependency.

## Hard rules

- Never write inside a harness directory (`~/.claude`, `~/.gemini`, `~/.codex`, `~/.local/share/opencode`, configured log roots). The product, its tests and its scripts only read (R-02, R-15).
- No API keys, tokens, passwords or credentials anywhere, including fixtures, docs and commit messages (R-13).
- No network calls and no telemetry in product code (R-14).
- No language models, randomness or non-deterministic ordering in analysis, classification, alerts or recommendations (R-10, R-11).
- No magic numbers: thresholds, multipliers and paths belong in the configuration file (R-72).
- Never commit real harness logs. Fixtures must be anonymized: no prompts, code, file contents, usernames or real paths (R-18, R-70).
- All repository content is English (R-04).

## Development

Requires Node.js 22.12 or newer.

```bash
npm ci          # install the locked development tools
npm test        # builds with tsc, then runs node --test
npm start       # builds, then serves the dashboard on 127.0.0.1:4317
```

## Adding a harness adapter

1. Open an issue describing the harness, its log location and the fields it records.
2. Write an ADR (`Proposed`) for the adapter, as [ADR 0018](docs/adr/0018-codex-adapter.md) does for Codex. State how each field maps to the normalized model, including whether input tokens include cached tokens.
3. Implement the adapter under `src/core/adapters/<harness>/`.
4. Add anonymized fixtures under `test/fixtures/<harness>/` and tests that pin the normalization.
5. Update the README harness table and [docs/configuration.md](docs/configuration.md).

## Pull requests

- Cite the requirement IDs (e.g. `R-42`) and the ADR your change serves in the PR description and commit messages.
- Every new rule, threshold or classification step needs a test that pins its behavior.
- Run `npm test` and say so in the PR. A test that did not run is reported as "not run".
- Update the docs your change affects (README, ADR index, configuration docs) in the same PR.
- Keep PRs focused; unrelated cleanups go in separate PRs.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
