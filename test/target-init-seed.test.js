import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeFingerprint } from "../dist/core/targets/fingerprint.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf8"));

test("repo init-seed writes fingerprintSeed and fingerprint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-init-seed-"));
  const storeDir = ".ato";
  const configPath = path.join(root, storeDir, "config.json");
  await writeJson(configPath, {
    version: 1,
    targetId: "test-target",
    storeDir,
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "repo", "init-seed", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const updated = await readJson(configPath);
  assert.ok(updated.fingerprintSeed);
  assert.ok(updated.fingerprint);
  const expected = computeFingerprint({
    targetId: updated.targetId,
    storeDir: updated.storeDir ?? ".ato",
    seed: updated.fingerprintSeed,
  });
  assert.equal(updated.fingerprint, expected);
});
