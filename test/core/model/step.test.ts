// Pins STEP-1 (ADR 0017): shell command and turn classification. Synthetic commands only (R-18, R-70).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyShellCommand, turnStepClass } from "../../../src/core/model/step.js";

describe("STEP-1 shell commands", () => {
  const cases: readonly (readonly [string, string, "edit" | "explore" | "other"])[] = [
    ["S1 cd then search through a pipe", "cd dir && rg pattern src | head", "explore"],
    ["S2 here-document written to a file", "cat > out.txt <<EOF\nline\nEOF", "edit"],
    ["S3 stderr to /dev/null", "grep pattern file.txt 2>/dev/null", "explore"],
    ["S4 sed in place", "sed -i s/a/b/ file.txt", "edit"],
    ["S5 test runner", "npm test", "other"],
    ["S7 sed print range", "sed -n 1,5p file.txt", "explore"],
    ["all output to /dev/null", "ls dir > /dev/null 2>&1", "explore"],
    ["&> to /dev/null", "npm test &>/dev/null", "other"],
    ["redirect to a file", "echo text > file.txt", "edit"],
    ["append to a file", "printf x >> file.txt", "edit"],
    ["git read subcommand after -C", "git -C dir log --oneline", "explore"],
    ["git write subcommand", "git commit -m message", "other"],
    ["environment assignment", "FOO=1 rg pattern", "explore"],
    ["env prefix", "env FOO=1 cat file.txt", "explore"],
    ["pipe inside quotes", "rg \"a|b\" src && wc -l file.txt", "explore"],
    ["perl in place", "perl -pi -e s/a/b/ file.txt", "edit"],
    ["here-document body is not parsed", "cat <<EOF\nrm -rf dir\nEOF", "explore"],
    ["commands after a here-document", "cat <<'EOF'\nbody\nEOF\nnpm test", "other"],
    ["absolute program path", "/usr/bin/grep pattern file.txt", "explore"],
    ["neutral segments are skipped", "cat a.txt; echo ---; cat b.txt", "explore"],
    ["only neutral segments", "cd dir", "other"],
    ["empty command", "", "other"],
    ["edit wins over explore", "rg pattern && mkdir out", "edit"],
    ["tee writes", "rg pattern | tee out.txt", "edit"],
    ["subshell", "(cd dir && ls)", "explore"],
    ["input redirection is read only", "wc -l < file.txt", "explore"],
    ["interpreter", "python3 script.py", "other"],
  ];
  for (const [name, command, expected] of cases) {
    it(name, () => assert.equal(classifyShellCommand(command), expected));
  }
});

describe("STEP-1 turn calls", () => {
  it("S8: edit when any tool call edits", () => {
    assert.equal(turnStepClass({ toolNames: ["Read", "Bash"], shellClasses: ["edit"] }), "edit");
  });

  it("explore when a tool call explores and none edits", () => {
    assert.equal(turnStepClass({ toolNames: ["Bash"], shellClasses: ["other", "explore"] }), "explore");
    assert.equal(turnStepClass({ toolNames: ["view_file"], shellClasses: [] }), "explore");
  });

  it("other for replies and unclassified tools", () => {
    assert.equal(turnStepClass({ toolNames: [], shellClasses: [] }), "other");
    assert.equal(turnStepClass({ toolNames: ["Bash"], shellClasses: ["other"] }), "other");
  });

  it("S6: apply_patch is an edit tool", () => {
    assert.equal(turnStepClass({ toolNames: ["apply_patch"], shellClasses: [] }), "edit");
  });
});
