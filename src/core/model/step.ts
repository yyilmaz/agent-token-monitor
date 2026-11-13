// STEP-1 (ADR 0017): edit, explore or other, from tool names and shell commands (R-10, R-18).
// Adapters classify a shell command as they read it and keep only the class; the command text is never stored.

import type { Call, StepClass } from "./index.js";

/** Named tools that write files. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "apply_patch",
]);

/** Named tools that read or search. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "grep",
  "grep_search",
  "find_by_name",
  "list_dir",
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "search_web",
]);

/** Programs whose segment writes files. `sed` and `perl` count only with an in-place flag. */
const EDIT_PROGRAMS: ReadonlySet<string> = new Set(["apply_patch", "tee", "touch", "mkdir", "mv", "cp", "rm"]);

/** Programs whose segment only reads or searches. */
const EXPLORE_PROGRAMS: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "sed", "awk", "grep", "rg", "ls", "find", "fd", "tree", "wc", "file", "stat", "jq",
]);

/** `git` subcommands that only read. */
const EXPLORE_GIT: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "blame"]);

/** Segments that neither read nor write: skipped when classifying. */
const NEUTRAL_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pwd", "echo", "printf", "true"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Segment {
  readonly words: readonly string[];
  readonly redirects: readonly string[];
}

/** Splits a shell command into segments at `&&`, `||`, `;`, `|`, `&`, parentheses and newlines outside quotes. */
function segmentsOf(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  let redirectNext = false;
  let skipNext = false;
  let heredoc: string | null = null;

  const endWord = () => {
    if (!inWord) return;
    if (skipNext) skipNext = false;
    else if (redirectNext) {
      redirects.push(word);
      redirectNext = false;
    } else if (heredoc === "") heredoc = word.replace(/^-/, "");
    else words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      const next = command[++i] as string;
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      continue;
    }
    if (c === "\n") {
      endSegment();
      if (heredoc !== null && heredoc !== "") {
        // Skip the here-document body up to and including its delimiter line.
        let pos = i + 1;
        while (pos < command.length) {
          const found = command.indexOf("\n", pos);
          const lineEnd = found === -1 ? command.length : found;
          const bodyLine = command.slice(pos, lineEnd).trim();
          pos = lineEnd + 1;
          if (bodyLine === heredoc) break;
        }
        heredoc = null;
        i = pos - 1;
      }
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "<") {
      endWord();
      if (command[i + 1] === "<" && command[i + 2] === "<") {
        i += 2;
        skipNext = true; // here-string: the next word is input
      } else if (command[i + 1] === "<") {
        i += 1;
        heredoc = ""; // the next word is the here-document delimiter
      } else {
        skipNext = true; // input redirection target
      }
      continue;
    }
    if (c === ">") {
      // A file descriptor prefix ("2>", "&>") belongs to the redirection, not to the words.
      if (inWord && /^(\d+|&)$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (command[i + 1] === ">") i += 1;
      if (command[i + 1] === "&") {
        i += 1;
        let digits = "";
        while (i + 1 < command.length && /\d/.test(command[i + 1] as string)) digits += command[++i];
        if (digits !== "" || command[i + 1] === "-") {
          if (command[i + 1] === "-") i += 1;
          continue;
        }
      }
      redirectNext = true;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (c === "&" && command[i + 1] === ">") {
        endWord();
        word = "&"; // "&>" is completed by the ">" branch
        inWord = true;
        continue;
      }
      endSegment();
      if ((c === "|" || c === "&") && command[i + 1] === c) i += 1;
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function inPlaceFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(arg));
}

function gitSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-C" || arg === "-c") i += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return null;
}

/** null for a neutral segment. */
function segmentClass(segment: Segment): StepClass | null {
  if (segment.redirects.some((target) => target !== "/dev/null")) return "edit";
  let start = 0;
  while (start < segment.words.length && ENV_ASSIGNMENT.test(segment.words[start] as string)) start += 1;
  if (segment.words[start] === "env") {
    start += 1;
    while (start < segment.words.length && ENV_ASSIGNMENT.test(segment.words[start] as string)) start += 1;
  }
  const first = segment.words[start];
  if (first === undefined) return segment.redirects.length > 0 ? "other" : null;
  const program = basename(first);
  const args = segment.words.slice(start + 1);
  if (NEUTRAL_PROGRAMS.has(program)) return null;
  if (EDIT_PROGRAMS.has(program)) return "edit";
  if ((program === "sed" || program === "perl") && inPlaceFlag(args)) return "edit";
  if (program === "git") {
    const sub = gitSubcommand(args);
    return sub !== null && EXPLORE_GIT.has(sub) ? "explore" : "other";
  }
  return EXPLORE_PROGRAMS.has(program) ? "explore" : "other";
}

/** STEP-1: `edit` when any segment edits, `explore` when every non-neutral segment explores, else `other`. */
export function classifyShellCommand(command: string): StepClass {
  const classes = segmentsOf(command).map(segmentClass).filter((c): c is StepClass => c !== null);
  if (classes.includes("edit")) return "edit";
  if (classes.length > 0 && classes.every((c) => c === "explore")) return "explore";
  return "other";
}

/** STEP-1: a turn call is `edit` when any tool call edits, else `explore` when any explores, else `other`. */
export function turnStepClass(call: Pick<Call, "toolNames" | "shellClasses">): StepClass {
  if (call.toolNames.some((t) => EDIT_TOOLS.has(t)) || call.shellClasses.includes("edit")) return "edit";
  if (call.toolNames.some((t) => EXPLORE_TOOLS.has(t)) || call.shellClasses.includes("explore")) return "explore";
  return "other";
}
