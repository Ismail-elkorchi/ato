import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
};

const collectMarkdownFiles = async (root, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(root, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files;
};

const loadHoldoutTasks = async (root) => {
  const blocksDir = path.join(root, ".ato", "meta", "blocks");
  const entries = await fs.readdir(blocksDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".closure.json") &&
        !entry.name.endsWith(".seal.json"),
    )
    .map((entry) => path.join(blocksDir, entry.name))
    .sort();

  const tasks = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    const holdout = parsed?.holdout;
    if (!holdout || !Array.isArray(holdout.tasks)) continue;
    for (const task of holdout.tasks) {
      if (!task || !Array.isArray(task.cmd)) continue;
      tasks.push({ file: path.relative(root, file), cmd: task.cmd });
    }
  }
  return tasks;
};

const collectSrcFiles = async (root, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath.includes(`${path.sep}fixtures${path.sep}`)) continue;
      files.push(...(await collectSrcFiles(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files;
};

const loadClosedBlocks = async (root) => {
  const blocksDir = path.join(root, ".ato", "meta", "blocks");
  const entries = await fs.readdir(blocksDir, { withFileTypes: true });
  const closed = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".closure.json")) continue;
    const raw = await fs.readFile(path.join(blocksDir, entry.name), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.blockId === "string") {
      closed.add(parsed.blockId);
    }
  }
  return closed;
};

const hasLegacyTokenPairs = (content) => {
  const sanitized = content.replace(/--queue-target/g, "");
  if (/\bATO_TARGET\b/.test(sanitized)) return true;
  if (/(^|\s)ato\s+target(\s|$)/i.test(sanitized)) return true;
  return /(^|\s)--target(\s|$)/.test(sanitized);
};

test("docs, src, holdouts, and active seals avoid legacy target tokens", async () => {
  const root = repoRoot();
  const docsDirs = [path.join(root, "docs"), path.join(root, ".ato", "contracts")];
  const docFiles = [path.join(root, "AGENTS.md")];

  for (const dir of docsDirs) {
    const exists = await fs
      .stat(dir)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (!exists) continue;
    const files = await collectMarkdownFiles(root, dir);
    docFiles.push(...files.map((rel) => path.join(root, rel)));
  }

  const legacyDocMatches = [];
  for (const filePath of docFiles) {
    const content = await fs.readFile(filePath, "utf8");
    if (hasLegacyTokenPairs(content)) {
      legacyDocMatches.push(path.relative(root, filePath));
    }
  }

  assert.deepEqual(
    legacyDocMatches,
    [],
    `Legacy repo tokens found in docs: ${legacyDocMatches.join(", ")}`,
  );

  const holdoutTasks = await loadHoldoutTasks(root);
  const legacyHoldoutMatches = [];
  for (const task of holdoutTasks) {
    const tokens = task.cmd.map((token) => String(token));
    if (tokens.includes("--target") || tokens.includes("target")) {
      legacyHoldoutMatches.push(task.file);
    }
    if (tokens.some((token) => token.includes("ATO_TARGET"))) {
      legacyHoldoutMatches.push(task.file);
    }
  }

  assert.deepEqual(
    [...new Set(legacyHoldoutMatches)],
    [],
    `Legacy repo tokens found in holdout definitions: ${[...new Set(legacyHoldoutMatches)].join(", ")}`,
  );

  const srcDir = path.join(root, "src");
  const srcFiles = await collectSrcFiles(root, srcDir);
  const legacySrcMatches = [];
  for (const relPath of srcFiles) {
    const content = await fs.readFile(path.join(root, relPath), "utf8");
    if (hasLegacyTokenPairs(content)) {
      legacySrcMatches.push(relPath);
    }
  }
  assert.deepEqual(
    legacySrcMatches,
    [],
    `Legacy repo tokens found in src: ${legacySrcMatches.join(", ")}`,
  );

  const closedBlocks = await loadClosedBlocks(root);
  const sealsDir = path.join(root, ".ato", "meta", "blocks");
  const sealEntries = await fs.readdir(sealsDir, { withFileTypes: true });
  const sealMatches = [];
  for (const entry of sealEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".seal.json")) continue;
    const blockId = entry.name.replace(".seal.json", "");
    if (closedBlocks.has(blockId)) continue;
    const content = await fs.readFile(path.join(sealsDir, entry.name), "utf8");
    if (hasLegacyTokenPairs(content)) {
      sealMatches.push(path.join(".ato", "meta", "blocks", entry.name));
    }
  }
  assert.deepEqual(
    sealMatches,
    [],
    `Legacy repo tokens found in active seal files: ${sealMatches.join(", ")}`,
  );
});
