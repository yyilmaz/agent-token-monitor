# 0017. Session advice: keep going, compact or start fresh

- Status: Accepted
- Date: 2026-11-13
- Requirements: R-10, R-11, R-16, R-17, R-18, R-22, R-30, R-51, R-60, R-62, R-63, R-72

## Context

An open session can continue, compact its history into a summary, or start fresh. Compaction processes the current context and produces summary tokens, then later calls process the smaller context. A new session first writes its own baseline context to the cache, then each step reads that smaller context. R-60 requires concrete advice with an expected token saving based on the user's history, and R-51 limits the comparison to token units.

Whether a change pays off depends on how long the work after it lasts: a fresh session costs more up front and less per step, so it pays back only after enough steps. The product cannot know what the user will ask next or how long it will take; the user does. The advice must therefore:

- state the condition under which a change pays back (*"a new task of 2+ messages"*), so the user decides with what they know;
- answer two questions separately: *for a new task* (keep going against a fresh session) and *to continue the current task* (keep going against compacting), because only a new task can drop the current context;
- speak only when the condition is realistic for this user's work, and stay quiet otherwise;
- produce exactly one verdict per session from one rule, so a safety condition (a running subagent) can never be hidden behind a token comparison;
- still compare a fresh session when a harness logs no compaction figures (Codex, Antigravity);
- classify steps from every harness, including steps that read or edit files through a shell tool.

Claude Code logs compaction figures: each `compact_boundary` line carries `compactMetadata` with `trigger` (`manual` or `auto`), `preTokens` (context before) and `postTokens` (summary size). Antigravity logs a `CHECKPOINT` step without token counts. Codex logs a `compacted` entry without token counts. All three adapters emit `userTurn` Events (ADR 0008).

## Decision

All rules are pure functions in `src/core/analysis/` over the normalized model (ADR 0008), the cache analysis (ADR 0009) and the configured token weights. They give advice only for open top-level sessions (`LIVE-1`): the user drives those, so only they can act on it. Subagent rows carry no advice.

### Compaction figures in the data model

**Rule `COMPACT-1` (adapter).** A compaction Event (ADR 0008) carries `compaction: { trigger, preTokens, postTokens } | null`. The Claude Code adapter fills it from `compactMetadata`; any field the line lacks is `null`, and an adapter whose harness logs none (Antigravity, Codex) sets `null` (R-16, R-22). Fixture tests pin the mapping.

### Step classes from tool calls

**Rule `STEP-1` (adapter + analysis).** Every turn call gets a step class: `edit`, `explore` or `other`.

- **Named tools.** Edit tools: `edit_file`, `write_file`, `replace_file_content`, `multi_replace_file_content`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `apply_patch`. Explore tools: `read_file`, `view_file`, `view_file_outline`, `view_code_item`, `grep`, `grep_search`, `find_by_name`, `list_dir`, `Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, `search_web`.
- **Shell commands.** The adapter reads a shell command only to classify it, stores the class in `Call.shellClasses` (one entry per shell call, in call order) and keeps no command text (R-18).
  - Outside quotes, the command is split into segments at `&&`, `||`, `;`, `|`, `&`, parentheses and newlines. A here-document body is skipped up to its delimiter line.
  - Redirections are not words: output to a target (`>`, `>>`, `&>`) is recorded, `2>&1`-style descriptor copies and input redirections (`<`, `<<<`) are ignored.
  - In each segment, leading environment assignments and an `env` prefix are skipped; the base name of the next word is the program.
  - A segment is **neutral** and skipped when its program is `cd`, `pwd`, `echo`, `printf` or `true` (and it redirects nothing).
  - A segment is **`edit`** when it redirects output to a target other than `/dev/null`, when its program is `apply_patch`, `tee`, `touch`, `mkdir`, `mv`, `cp` or `rm`, or when it is `sed` or `perl` with an in-place flag (`-i`, a flag group containing `i`, or `--in-place`).
  - A segment is **`explore`** when its program is `cat`, `head`, `tail`, `sed`, `awk`, `grep`, `rg`, `ls`, `find`, `fd`, `tree`, `wc`, `file`, `stat` or `jq`, or `git` whose subcommand (after `-C`/`-c` options) is `status`, `log`, `diff`, `show` or `blame`. Any other segment is `other`.
  - The shell call is `edit` when any segment is `edit`, `explore` when every non-neutral segment is `explore` (and there is at least one), otherwise `other`.
- **Where each harness logs shell commands.**
  - Claude Code: the `command` input of a `Bash` tool_use, counted once per tool_use id.
  - Antigravity: `args.CommandLine` of a `run_command` call; the log stores it JSON-encoded, so a value in quotes is decoded first.
  - Codex: the Codex adapter fills `toolNames` and `shellClasses` from the `function_call`, `custom_tool_call` and `local_shell_call` response items logged since the previous request (ADR 0018). The script tools `exec` (input) and `js` (`code` argument) contribute each nested `tools.<name>(…)` call; a nested `exec_command` is classified from its literal `cmd` string, else `other`. The tools `shell`, `exec_command` and `local_shell` are classified from `cmd` or `command` (an argv `["bash", "-lc", script]` runs its script).
- **Turn class.** A turn call is `edit` when any of its tool calls is `edit`. Otherwise it is `explore` when any is `explore`. Otherwise it is `other`.

The program lists are code, pinned by tests, like the named tool sets. Fixture tests with synthetic commands pin each harness's argument field.

### Figures from the user's own history

Per harness and effective model (ADR 0009 `MODEL-1`), over the whole history, from top-level sessions only. With an even count, each median takes the lower middle value. Below its minimum count each figure is `unknown`.

- **`FRESH-1`, typical start of a new session:** the median context size (`inputUncached + cacheRead + cacheWrite`) of the first turn call of every session. At least `rules.freshSession.minSessions` sessions.
- **`TASK-1`, typical task length:** the median number of turn calls per session, over the same sessions as `FRESH-1` (so it is known exactly when `FRESH-1` is). A session stands for one task.
- **`STEPS-1`, steps per message:** the median number of turn calls between one `userTurn` Event and the next `userTurn` Event (or the session's last call) in the same session. A user turn followed by no turn call is not counted. At least `rules.sessionAdvice.minUserTurns` user turns. It converts steps into the messages the user counts.
- **`POSTCOMPACT-1`, context after compacting:** the median context size of the first turn call after each compaction Event in the same session. At least `rules.sessionAdvice.minCompactions` compactions.
- **`SUMMARY-1`, summary size:** the median `postTokens` of those compactions. The summarization request itself is not logged (ADR 0008), so its output is taken to be the summary. This is a derived estimate, labeled as one.

### One decision per session

**Rule `ADVICE-1`.** For each open top-level session, the first matching step decides the verdict:

1. **Wait.** One or more child subagents are active (open, warm cache, a call at or after the parent's last call). Verdict `wait`: the subagent will report back into this session, so the user should not leave it.
2. **Unknown session.** The effective model or the current context `C` is unknown. Verdict `unknown`, naming the missing figure.
3. **Lean.** `C < rules.sessionAdvice.leanContextTokens`. Verdict `lean` (keep going): the context is small, and losing it costs the user more than the tokens it saves.
4. **Unknown history.** `FRESH-1`, `TASK-1` or `STEPS-1` is unknown. Verdict `unknown`, naming the missing figure.
5. **Compare.** Otherwise verdict `compare`, with two cases:
   - **For a new task:** keep going against a fresh session.
   - **To continue this task:** keep going against compacting. When `POSTCOMPACT-1` or `SUMMARY-1` is unknown, this case keeps going and names the missing figure.

Let `C` be the current context, `P` the context after compaction, `S` the summary size and `F` the fresh context. Let `r`, `w` and `o` be the configured cache-read, cache-write and output weights from `rules.sessionAdvice.weights`.

| Option | Initial load | Load per later step |
|---|---|---|
| Keep going, warm | 0 | `C × r` |
| Keep going, cold | `C × w` | `C × r` |
| Compact, warm | `C × r + S × o + S × w` | `P × r` |
| Compact, cold | `C × w + S × o + P × w` | `P × r` |
| Start fresh | `F × w` | `F × r` |

A session is cold when `LIVE-1` reports `probably cold` or `missed on last call`. Later steps are treated as cache reads; their common output load is omitted. All arithmetic uses integer millionths of a weighted token unit, so fractional weights cannot change ties or break-even steps.

For each case:

- **Break-even steps:** the first nonnegative whole number of steps at which the alternative's load (initial plus steps × per step) is no greater than keeping going: `0` when its initial load is no greater, `never` when it starts higher and saves nothing per step, otherwise `ceil(initial gap ÷ per-step saving)`.
- **Break-even messages:** `ceil(break-even steps ÷ STEPS-1)`.
- **Totals over a typical task:** each option's initial load plus `TASK-1` times its per-step load. The saving is the keep-going total minus the alternative's total.
- **Advice:** the alternative when its saving over a typical task is strictly positive, that is, it pays back within a typical task; otherwise keep going. A tie keeps going, the less disruptive option.

### Workflow profile

**Rule `WORKFLOW-1`.** Detail information only. It never sets the verdict or the badge. Over the session's active context window (turn calls after its latest compaction Event, or all turn calls), it reports:

- `turns`, `editTurns`, `exploreTurns` and `otherTurns` by `STEP-1`;
- `subagentCount`, `activeSubagentCount` and `subagentTokens`;
- `splitBreakEvenSteps`: when `C ≥ leanContextTokens` and `C > F`, `floor(2 × C ÷ (C − F)) + 1`. This is the minimum number of steps an independent subtask needs before a subagent processes fewer context tokens than this session would (two parent turns at `C` to spawn and receive, plus `k` subagent turns at `F`: `2 × C + k × F < k × C`). Otherwise `null`;
- an `explorationHeavy` hint when `C ≥ leanContextTokens`, `exploreTurns ≥ 3`, `exploreTurns > 2 × editTurns` and `exploreTurns × 2 ≥ turns`: the context grew mainly from read and search steps, so independent multi-step subtasks are better delegated.

### What the user sees

The Now view's Advice column shows the badge, one line with the break-even and the typical task length, and one line with the `WORKFLOW-1` profile. `N` is the break-even in messages.

| Verdict | Badge |
|---|---|
| `wait` | **Wait** · N subagent(s) running |
| `unknown` | **Unknown** · missing figure |
| `lean` | **Keep going** · lean context |
| new task → start fresh, `N ≤ 1` | **New task? Start fresh** |
| new task → start fresh, `N ≥ 2` | **New task of N+ messages? Start fresh** |
| same task → compact, `N ≤ 1` | **Same task? Compact** |
| same task → compact, `N ≥ 2` | **Task goes on N+ messages? Compact** |
| both cases keep going | **Keep going** |

When both cases recommend a change, both badges are shown. The summary line reads, for example, *"fresh pays back after ~2 messages · typical task ~16 messages"*. The detail drawer shows the inputs (`C`, cache state, `F`, `TASK-1`, `STEPS-1`, `P`, `S`), every option's initial load, per-step load, total over a typical task, saving and break-even, the parameters and weights, the rule IDs and the `WORKFLOW-1` profile (R-17, R-63). The estimate compares token load only. The product never takes these actions itself (R-62).

### Parameters

| Key | Default | Why |
|---|---|---|
| `rules.freshSession.minSessions` | 5 | a median of fewer sessions says little (`FRESH-1`, `TASK-1`) |
| `rules.sessionAdvice.minUserTurns` | 5 | the same for steps per message |
| `rules.sessionAdvice.minCompactions` | 5 | the same for compaction figures |
| `rules.sessionAdvice.leanContextTokens` | 50000 | below this, the context is worth more to the user than the tokens a change would save |
| `rules.sessionAdvice.recentTurnsWindow` | 5 | recent turns averaged for the per-step load column |
| `rules.sessionAdvice.weights` | `{ cacheRead: 0.1, inputUncached: 1, cacheWrite: 1.25, output: 5 }` | token weights (`1` = `1` uncached input token) for advice, step, session and subagent weighted load |

### Acceptance scenarios

Tests pin these cases with synthetic figures and the default weights and parameters. Claude Code: `F` = 80,000, `STEPS-1` = 5, `TASK-1` = 80 steps (16 messages), `P` = 95,000, `S` = 20,000. Antigravity: `F` = 20,000, `STEPS-1` = 8, `TASK-1` = 32, no compaction figures. Codex: `F` = 15,000, `STEPS-1` = 10, `TASK-1` = 40, no compaction figures. Break-even is given as steps (messages).

| # | Harness | `C` | Cache | Subagents running | New task | Same task | Badge |
|---|---|---|---|---|---|---|---|
| A1 | Claude Code | 252,000 | warm | 1 | — | — | Wait · 1 subagent running |
| A2 | Claude Code | 252,000 | warm | 0 | 6 (2) → start fresh | 10 (2) → compact | New task of 2+ messages? Start fresh · Task goes on 2+ messages? Compact |
| A3 | Claude Code | 175,000 | warm | 0 | 11 (3) → start fresh | 18 (4) → compact | New task of 3+ messages? Start fresh · Task goes on 4+ messages? Compact |
| A4 | Claude Code | 100,000 | warm | 0 | 50 (10) → start fresh | 270 (54) → keep | New task of 10+ messages? Start fresh |
| A5 | Claude Code | 92,400 | warm | 0 | 81 (17) → keep | never → keep | Keep going |
| A6 | Claude Code | 92,500 | warm | 0 | 80 (16), tie over a typical task → keep | never → keep | Keep going |
| A7 | Claude Code | 92,600 | warm | 0 | 80 (16), saves 800 → start fresh | never → keep | New task of 16+ messages? Start fresh |
| A8 | Claude Code | 60,000 | warm | 0 | never → keep | never → keep | Keep going |
| A9 | Claude Code | 30,000 | warm | 0 | — | — | Keep going · lean context |
| A10 | Claude Code (subagent row) | any | any | — | — | — | no advice |
| B1 | Antigravity | 75,600 | warm | 0 | 5 (1) → start fresh | figures unknown → keep | New task? Start fresh |
| B2 | Antigravity | 25,300 | cold | 0 | — | — | Keep going · lean context |
| B3 | Antigravity | 135,900 | cold | 0 | 0 (0) → start fresh | figures unknown → keep | New task? Start fresh |
| C1 | Codex | 246,400 | warm | 0 | 1 (1) → start fresh | figures unknown → keep | New task? Start fresh |
| D1 | any | ≥ 50,000 | any | 0 | effective model unknown | — | Unknown · model |
| D2 | any | ≥ 50,000 | any | 0 | fewer than 5 sessions for `FRESH-1` | — | Unknown · fresh start |
| D3 | any | ≥ 50,000 | any | 0 | fewer than 5 user turns for `STEPS-1` | — | Unknown · steps per message |
| D4 | any | any | any | 1 | `FRESH-1` unknown | — | Wait · 1 subagent running |
| D5 | any | ≥ 50,000 | warm | 0 | all weights zero: break-even 0, saving 0 → keep | — | Keep going |

`STEP-1` cases (more are pinned in `test/core/model/step.test.ts`):

| # | Tool call | Class |
|---|---|---|
| S1 | `Bash`: `cd dir && rg pattern src \| head` | explore |
| S2 | `Bash`: `cat > out.txt <<EOF …` | edit |
| S3 | `Bash`: `grep pattern file.txt 2>/dev/null` | explore |
| S4 | `Bash`: `sed -i s/a/b/ file.txt` | edit |
| S5 | `Bash`: `npm test` | other |
| S6 | Codex `exec` calling `tools.apply_patch(…)` | edit, and `toolNames` contains `apply_patch` |
| S7 | Codex `exec_command` with `sed -n 1,5p file.txt` | explore |
| S8 | turn with `Read` and a `Bash` edit | edit |

## Alternatives considered

- **Pick the lowest of the three totals as one verdict.** Starting fresh nearly always has the lowest total, so the advice ignores whether the user still needs the context. Two cases (new task, same task) state the condition explicitly.
- **A fixed horizon of one message.** A new task rarely ends after one message. With the user's real figures (fresh start ≈ 80,000 tokens, ≈ 5 steps per message) a fresh session never paid back within one message below ≈ 373,000 tokens, so the advice was always "keep going".
- **Recommend when the saving over a horizon exceeds a fixed share.** Needs a guessed horizon and a guessed share, and says "saves 63%" instead of the condition the user can check. The break-even in messages states that condition directly, and `TASK-1` bounds it to the user's own work.
- **Horizon from messages still to come in the current context band.** The median per context band jumps at each band edge, so the verdict flips between neighbouring context sizes.
- **Separate workflow badges next to the token advice.** Two rule systems competing for one badge hid running subagents behind a token verdict. The workflow profile stays as detail only.
- **Count shell steps as `other`.** Simpler and reads no arguments, but leaves Codex and shell-heavy Claude Code sessions at zero edit and explore steps, which makes the profile wrong.
- **Fall back to the session's own first context when `FRESH-1` is unknown.** One sample can include a large first prompt and overstate the baseline. `unknown` with the missing figure named is more honest.

## VS Code compatibility

- `COMPACT-1` and the adapter part of `STEP-1` live in the adapters; `STEP-1` classification lives in `src/core/model/step.ts`; `FRESH-1`, `TASK-1`, `STEPS-1`, `POSTCOMPACT-1`, `SUMMARY-1`, `ADVICE-1` and `WORKFLOW-1` are pure functions over the normalized model with no host access (ADR 0006), and run unchanged in the extension host.
- The advice travels in the overview payload as JSON token units. The Webview renders the same data as the browser.
- The parameters live in the configuration file and validator (ADR 0007).

## Consequences

- One rule decides each badge; a running subagent always shows as **Wait**.
- The badge is conditional: it names the task length from which a change pays back, and the user decides with what they know about the next work.
- A warm session's new-task advice appears once `C` is large enough for a fresh session to pay back within a typical task: `C > F + F × w ÷ (r × TASK-1)`. With the Claude Code scenario figures that is above 92,500 tokens (A6, A7).
- Fresh-session advice works for every harness with enough history; compaction advice only where compaction figures are logged (Claude Code).
- `STEP-1` reads shell command strings transiently to classify them; ADR 0008 allows this and stores only the class.
- `SUMMARY-1` estimates summary output from compaction metadata. When required figures are unavailable, the affected case is reported with the missing figure named.
