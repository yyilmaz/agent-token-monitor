# 0016. Session titles and session tree

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-15, R-16, R-17, R-18, R-22, R-23, R-24, R-26, R-31, R-33, R-72

## Context

Claude Code desktop sessions can start side sessions, often in separate worktrees. Sessions can also start subagents. Session titles and parent links let the dashboard distinguish sessions and group related activity.

The desktop app's session index connects its own session IDs to CLI session IDs. It also records which desktop session started a side session. Claude Code logs and subagent metadata provide titles for sessions without a desktop index entry.

## Decision

### Sources

1. **Log title:** the Claude Code adapter reads the `customTitle` of the last `custom-title` line of each session file.
2. **Subagent title:** the Claude Code adapter reads `agent-<id>.meta.json` next to each subagent log and keeps only `description`. A file it cannot parse is a diagnostic (R-23).
3. **Desktop session index:** a new configuration key `sessionIndexRoots`, per harness, lists folders of session index files. The default is `{ "claudeCode": ["~/Library/Application Support/Claude/claude-code-sessions"], "antigravity": ["~/.gemini/antigravity/annotations"], "codex": [], "opencode": [] }`. Other platforms set their own path (R-24). A missing folder is not an error: the desktop app may not be installed.

   The Claude Code adapter reads each `local_*.json` below it. It keeps only `sessionId`, `cliSessionId`, `priorCliSessionIds`, `title` and `spawnedFrom.sessionId`, and discards the rest of the file as soon as it is parsed (R-18). The Antigravity adapter reads each `<conversation-id>.pbtxt` in its index root and keeps only `title`. Reading is read-only, like every log root (R-15). A file an adapter cannot parse is a diagnostic (R-23).

### Model (ADR 0008)

`Session` gains two fields:

- `title`: the desktop index title, else the log title, else, for a subagent, its meta file's `description`, else `null`. Shown as recorded, never shortened by a rule (R-16).
- `spawnedBySessionId`: the session that started this one as a side session, else `null`. It is set when the index file's `spawnedFrom.sessionId` resolves, through that session's `cliSessionId`, to a session in the logs. A link that does not resolve stays `null`, and the diagnostics count it.

The index entry applies to `cliSessionId` and to every ID in `priorCliSessionIds`, the earlier log sessions of the same desktop session. `parentSessionId` and `isSubagent` keep their meaning: subagents only. A side session is driven by the user, so the session rules of ADR 0015 apply to it, as to any top-level session.

Sessions are linked only through recorded IDs. There is no guessing by worktree, folder or time (R-16).

### Dashboard (ADR 0013)

- Every session shows its title, else its project folder, as now.
- **Now view, rule `TREE-1`:** open sessions are shown as a tree. A session's children are its side sessions and its subagents, ordered by last call, newest first. A session that is not open itself appears when one of its descendants is open, marked "waiting", so a main session waiting on its side sessions does not vanish. Roots are ordered by the newest last call in their tree.
- The session view names the session's starter and its side sessions, with links. Its subagents are a table (title, last call, steps, units, units per step), newest last call first, a subagent with no calls last. The table shows `ui.subagentRowsShown` rows and a **Show more** button for the rest. A value the logs do not give is shown as "–", never as `0` or "unknown" text.

### Fixtures

Fixture index files hold invented titles and IDs only (R-70).

## Alternatives considered

- **Log titles only, no index:** no new source, but side sessions stay unlinked, which is a central goal of the session tree.
- **Grouping side sessions by worktree or start time:** needs no index, but is a guess; a wrong tree is worse than a flat list (R-16).
- **Reading the desktop app's IndexedDB or other stores:** more data, but undocumented binary formats; the per-session JSON files are enough.
- **Treating side sessions as subagents (`parentSessionId`):** one field fewer, but subagents are excluded from session alerts (ADR 0015) and side sessions should not be.

## VS Code compatibility

- Reading the index is part of the Claude Code adapter's pure `readFile` and `combine` (ADR 0014); the host only lists and reads files, as for logs. The extension reads the same folders through its host, read-only.
- The tree is rendered by the same frontend in the Webview.

## Consequences

- Rows carry their session titles, and side sessions sit under the session that started them.
- The product depends on a file format of the Claude desktop app, which can change without notice. A changed format shows as diagnostics and missing links, never as wrong links, and the log-only behavior still works.
- Titles may summarize what the user asked for (the app generates them). They are shown and exported as recorded (R-71).
