# AGENTS.md

Working rules for every AI agent (Antigravity, Claude Code, Codex, OpenCode, …) in this repository. These rules govern how we build, not what we build. Keep this file short: it is loaded into every model call.

## 1. Authority

- Order of authority: **`docs/SRS.md` > accepted ADRs in `docs/adr/` > this file > code.** When they conflict, the higher one wins.
- If a task would violate the SRS or an accepted ADR, stop and ask the owner. Never work around a requirement.
- Read only what the task needs: start with the SRS sections and ADRs it touches, not the whole repository.

## 2. Scope and approval

- The owner approves a **scope of work** (a task, an issue or an ADR to implement). Inside that scope, work freely: read, edit, create files and run tests without asking at each step.
- Ask before going beyond the approved scope, before deleting or rewriting unrelated files, and before adding a new dependency.
- **Commit and push only with the owner's explicit approval.** Never force-push or rewrite published history.

## 3. Requirements and decisions

- **Only the owner changes the SRS.** Agents MAY propose a change: describe it and wait.
- **Every decision must keep the product shippable as a native VS Code extension (R-26).** If it would not work inside the VS Code extension host or a Webview, stop and ask.
- **Every significant technical decision is an ADR first** (language, library, data format, algorithm with tunable parameters, UI technology). Write it as `Proposed` using `docs/adr/README.md`. Do not implement it until the owner accepts it.
- **Keep code, documentation and ADRs aligned with the current state.** Revise an ADR when its decision changes. Delete it when the decision no longer applies and move any still-valid decisions into the ADRs that govern them. No `Partial` or superseded ADRs, revision logs or "previously" notes. Git history is the archive.

## 4. Hard rules (never break)

- **Harness directories are read-only. Always.** Never write anything inside the directories of Antigravity, Claude Code, Codex, OpenCode or any other harness (`~/.claude`, `~/.gemini`, `~/.codex`, `~/.local/share/opencode`, configured log roots, their apps): no new files, not even our own unrelated ones, no edits, no moves, no deletes, no setting changes. Only read. This applies to the product, its tests, its scripts and to you, the agent, while working here (R-02, R-15).
- No API keys, tokens, passwords or credentials anywhere: not in code, config, fixtures, docs or commit messages (R-13).
- Never commit real harness logs. Test fixtures must be anonymized: no prompts, code, file contents, usernames or real paths (R-18, R-70).
- No network calls and no telemetry in product code (R-14).
- No language models, randomness or non-deterministic ordering in analysis, classification, alerts or recommendations (R-10, R-11).
- No magic numbers: thresholds, multipliers and paths go in the configuration file (R-72).

## 5. Traceability

- Code, tests and commit messages cite the requirement IDs they serve (e.g. `R-42`), and the ADR when one applies.
- Every new rule, threshold or classification step needs a test that pins its behavior.

## 6. Definition of done

A task is done only when:

1. The change satisfies the cited requirements and accepted ADRs.
2. The relevant tests were **actually run** and pass. Never report a test as passing if it did not run; say "not run" and why.
3. Docs affected by the change (README, ADR index, configuration docs) are updated in the same change.
4. No unexplained warnings remain.

## 7. Language and communication

- All repository content is English (R-04).
- Talk to the owner in their preferred language. Be concise, and name risks and better options rather than agreeing by default.
