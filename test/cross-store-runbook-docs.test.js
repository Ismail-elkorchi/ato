import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RUNBOOK_HEADER = "### Cross-store workflow runbook (canonical)";
const REPO_PATTERN = /\bato\s+--repo\s+\S+/;

const extractRunbookSection = (lines) => {
  const start = lines.findIndex((line) => line.trim() === RUNBOOK_HEADER);
  assert.notEqual(start, -1, "Runbook section not found.");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("### ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
};

test("runbook commands place global --repo before the command token", () => {
  const doc = readFileSync("docs/USER_GUIDE.md", "utf8");
  const lines = doc.split("\n");
  const sectionLines = extractRunbookSection(lines);
  let repoLines = 0;
  for (const line of sectionLines) {
    if (!line.includes("--repo")) continue;
    repoLines += 1;
    assert.ok(REPO_PATTERN.test(line), `Bad --repo placement: ${line}`);
  }
  assert.ok(repoLines > 0, "Expected at least one --repo example in runbook.");
});
