import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
};

const collectFiles = async (root, dir, predicate) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath, predicate)));
    } else if (entry.isFile() && (!predicate || predicate(fullPath))) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files;
};

const legacyTokens = [
  ".ato/memory/goals.json",
  ".ato/memory/plans.json",
  ".ato/memory/intent/goals.jsonl",
  ".ato/memory/intent/plans.jsonl",
];

const hasLegacyTokens = (content) =>
  legacyTokens.some((token) => content.includes(token));

test("docs and source avoid legacy goal/plan store references", async () => {
  const root = repoRoot();
  const docsDirs = [path.join(root, "docs"), path.join(root, ".ato", "contracts")];
  const docFiles = [path.join(root, "README.md"), path.join(root, "AGENTS.md")];

  for (const dir of docsDirs) {
    const exists = await fs
      .stat(dir)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (!exists) continue;
    const files = await collectFiles(root, dir, (fullPath) => fullPath.endsWith(".md"));
    docFiles.push(...files.map((rel) => path.join(root, rel)));
  }

  const legacyDocMatches = [];
  for (const filePath of docFiles) {
    const content = await fs.readFile(filePath, "utf8");
    if (hasLegacyTokens(content)) {
      legacyDocMatches.push(path.relative(root, filePath));
    }
  }

  assert.deepEqual(
    legacyDocMatches,
    [],
    `Legacy intent store references found in docs: ${legacyDocMatches.join(", ")}`,
  );

  const srcDir = path.join(root, "src");
  const srcFiles = await collectFiles(root, srcDir);
  const legacySrcMatches = [];
  for (const relPath of srcFiles) {
    const content = await fs.readFile(path.join(root, relPath), "utf8");
    if (hasLegacyTokens(content)) {
      legacySrcMatches.push(relPath);
    }
  }

  assert.deepEqual(
    legacySrcMatches,
    [],
    `Legacy intent store references found in src: ${legacySrcMatches.join(", ")}`,
  );
});
