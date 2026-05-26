import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const computeHash = (tasks) =>
  crypto.createHash("sha256").update(stableStringify(tasks)).digest("hex");

const repoRoot = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
};

const loadHoldoutTasks = async (root) => {
  const blockPath = path.join(root, ".ato", "meta", "blocks", "block-0001.json");
  const raw = await fs.readFile(blockPath, "utf8");
  const block = JSON.parse(raw);
  const holdout = block.holdout ?? null;

  assert.ok(holdout, "Holdout config missing from block-0001.json");
  assert.ok(
    Array.isArray(holdout.tasks) && holdout.tasks.length > 0,
    "Holdout tasks must be a non-empty array",
  );
  assert.ok(
    typeof holdout.hash === "string" && holdout.hash.length > 0,
    "Holdout hash must be set",
  );

  const computed = computeHash(holdout.tasks);
  assert.equal(
    computed,
    holdout.hash,
    "Holdout task hash mismatch; update hash when tasks change",
  );

  return holdout.tasks;
};

const runTask = (root, task) => {
  assert.ok(task && typeof task.id === "string" && task.id.length > 0);
  assert.ok(Array.isArray(task.cmd) && task.cmd.length > 0);

  const [bin, ...args] = task.cmd;
  const command = bin === "node" ? process.execPath : bin;
  const cwd = task.cwd ? path.resolve(root, task.cwd) : root;

  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15000,
  });
};

test("holdout suite runs fixed tasks", async () => {
  const root = repoRoot();
  const cliPath = path.join(root, "dist", "cli", "main.js");
  await fs.access(cliPath).catch(() => {
    throw new Error("dist/cli/main.js missing; run npm run build first");
  });

  const tasks = await loadHoldoutTasks(root);
  for (const task of tasks) {
    const result = runTask(root, task);
    assert.equal(
      result.status,
      0,
      `Holdout task ${task.id} failed (exit ${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
});
