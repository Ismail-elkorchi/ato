import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("init leaves eval store uncreated until explicit eval use", async () => {
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
  await assert.rejects(() => fs.access(ledgerPath), { code: "ENOENT" });
  await assert.rejects(() => fs.access(scorecardPath), { code: "ENOENT" });

  const scorecard = spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "eval", "scorecard", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(scorecard.status, 0, scorecard.stderr);
  const scorecardPayload = JSON.parse(scorecard.stdout.trim());
  assert.equal(scorecardPayload.scorecard.version, 1);
  assert.equal(scorecardPayload.scorecard.cycles, 0);
});
