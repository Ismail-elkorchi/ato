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

test("closeout apply is blocked by lock without writing", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-dest-"));
  const storeDir = ".ato";

  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "closeout-src",
  });
  await fs.writeFile(
    path.join(sourceRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  await writeJson(path.join(destRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "dest",
    storeDir,
    fingerprintSeed: "closeout-dest",
  });
  await fs.writeFile(
    path.join(destRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.join(destRoot, storeDir, "queue"), { recursive: true });
  const destItemsPath = path.join(destRoot, storeDir, "queue", "items.jsonl");
  await fs.writeFile(destItemsPath, "", "utf8");
  await writeJson(path.join(sourceRoot, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root: destRoot, id: "dest" }],
  });
  await writeJson(path.join(destRoot, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "src" }],
  });

  const lockPath = path.join(destRoot, storeDir, "lock.json");
  await writeJson(lockPath, {
    // Use a live pid + fresh timestamp so the lock is treated as active,
    // not stale (stale locks are auto-cleared before write lock retry).
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  const before = await fs.readFile(destItemsPath, "utf8");

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "session",
      "closeout",
      "apply",
      "--dest",
      destRoot,
      "--allow-cross-store-write",
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error?.message.includes("Repo store is locked"));
  const expected = ["ato lock status --json", "ato lock clear --force --json"];
  assert.deepEqual(payload.error?.details?.suggested_commands, expected);

  const after = await fs.readFile(destItemsPath, "utf8");
  assert.equal(after, before);
});
