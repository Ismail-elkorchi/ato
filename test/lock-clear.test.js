import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("lock clear removes stale lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-lock-clear-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const lockPath = path.join(root, storeDir, "lock.json");
  await writeJson(lockPath, {
    pid: 999999,
    created_at: "2000-01-01T00:00:00.000Z",
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "lock", "clear", "--force", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.cleared, true);
  await assert.rejects(() => fs.stat(lockPath));
});
