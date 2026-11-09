# 0014. Incremental log reading

- Status: Accepted
- Date: 2026-10-31
- Requirements: R-10, R-15, R-22, R-23, R-25, R-26, R-32, R-70

## Context

The dashboard refreshes every few seconds (R-32). The standalone host notices changes with a read-only `stat` of every log file (ADR 0013), and until now re-read and re-parsed every file after any change.

Active sessions frequently append a few lines to a single file. Re-reading all files repeats the I/O and parsing cost for the entire log collection.

Most of the cost is per file: reading the text and parsing each JSON line. The steps that need several files at once are small:

- Claude Code: one request can appear in several files (a forked session copies earlier requests), and each is counted once.
- Antigravity: a subagent link file names a step in its parent conversation.

## Decision

### Adapters in two steps

Every adapter is split into two pure functions in `src/core/adapters/<harness>/`:

1. **`readFile(file)`**: reads one file's lines and returns a **file result**: the records found in that file (calls or request lines, events, session facts, subagent links) and its diagnostics. It looks at no other file. The result is plain JSON-safe data, like the model (ADR 0008).
2. **`combine(results)`**: takes the file results of all files and does everything that spans files: counting a request once, choosing the owning session, linking subagents, canonical sorting. It reads no text.

`parse(files)` stays as `combine(files.map(readFile))`, so tests and any host that reads everything at once get the same output as before.

**Rule:** `combine` sorts its input by log root and file path before using it, so its output does not depend on the order in which file results are kept or arrive (R-10). For every adapter, a fixture test pins that `combine` over per-file results equals `parse` over all files, byte for byte (R-70).

### Host cache of file results

- The host keeps, in memory only, each file's result together with the fingerprint it was read with (size and modification time, ADR 0013).
- On a change check, only files whose fingerprint differs, and new files, are read and passed to `readFile`. Results of files that disappeared are dropped. Then `combine` and the analysis run over all results.
- The file text is not kept after `readFile`; only the much smaller file results are. Nothing is written to disk (R-15).
- A changed configuration (for example a new log root) clears the cache.

A changed file is read whole. Logs are usually appended to, but reading only the new bytes needs a resumable position per file and a check that earlier bytes did not change; a single active file reads in tens of milliseconds, so this is not done.

## Alternatives considered

- **Re-reading everything on every change** (the previous approach): simplest, but repeats seconds of work and a gigabyte of memory for a few new lines.
- **Reading only appended bytes:** fastest for growing files, but needs per-file positions, detection of rewritten or truncated files, and partial-line handling. Revisable if single files become very large.
- **Caching parsed results on disk:** faster start-up, but writes files, which this product avoids, and adds invalidation across versions.
- **Keeping all file text in memory and re-parsing only changed files:** less adapter change, but keeps the full text of every log file resident.
- **Watching files with `fs.watch` to skip the `stat` sweep:** saves the sweep, but recursive watching differs per platform (ADR 0013); the sweep over about 600 files is fast.

## VS Code compatibility

- `readFile` and `combine` are pure functions in `src/core` (ADR 0006); the extension uses them the same way.
- The VS Code host keeps the same in-memory cache and may learn about changed files from VS Code file system watchers instead of a `stat` sweep; neither choice changes the core.

## Consequences

- A refresh after a few new lines costs reading one file plus `combine` and the analysis, instead of reading and parsing everything.
- Memory holds parsed records instead of raw log text.
- Each adapter has two entry points to keep consistent; the equality test catches drift.
- The analysis itself still runs over all calls on every change; if that becomes slow, it needs its own decision.
