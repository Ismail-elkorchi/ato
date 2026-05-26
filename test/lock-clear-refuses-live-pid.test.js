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

test("lock clear refuses when pid is alive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-lock-live-"));
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
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const clearResult = spawnSync(
    process.execPath,
    [cliPath, "lock", "clear", "--force", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(clearResult.status, 0);
  const payload = JSON.parse(clearResult.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 2);
  assert.ok(payload.error?.message.includes("Lock is active"));
  assert.equal(payload.error?.details?.status?.pidRunning, true);
  const expected = ["ato lock status --json", "ato lock clear --force --json"];
  assert.deepEqual(payload.error?.details?.suggested_commands, expected);

  const raw = await fs.readFile(lockPath, "utf8");
  const current = JSON.parse(raw);
  assert.equal(current.pid, process.pid);
});
