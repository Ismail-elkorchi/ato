import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const readGitignoreLines = () => {
  const gitignorePath = path.resolve(".gitignore");
  const contents = readFileSync(gitignorePath, "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

test(".gitignore ignores .ato/tmp", () => {
  const lines = readGitignoreLines();
  assert.ok(lines.includes("/.ato/tmp/"));
});
