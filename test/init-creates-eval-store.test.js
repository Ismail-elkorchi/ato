import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
};

test("init creates eval ledger and scorecard", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-init-eval-"));
  const cliPath = path.resolve("dist/cli/main.js");

  const result = spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "init", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const ledgerPath = path.join(root, ".ato", "eval", "ledger.jsonl");
  const scorecardPath = path.join(root, ".ato", "eval", "scorecard.json");
  await fs.access(ledgerPath);
  await fs.access(scorecardPath);

  const scorecard = await readJson(scorecardPath);
  assert.equal(scorecard.version, 1);
  assert.equal(scorecard.cycles, 0);
});
