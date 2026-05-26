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

test("closeout apply does not fail locked when lock disappears", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-lock-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-lock-dest-"));
  const storeDir = ".ato";

  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "lock-src",
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
    fingerprintSeed: "lock-dest",
  });
  await fs.writeFile(
    path.join(destRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
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
    pid: 999999,
    created_at: "2026-01-02T01:27:27.721Z",
  });

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
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...process.env, ATO_LOCK_TEST_REMOVE_BEFORE_STATUS: "1" },
    },
  );

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
});
