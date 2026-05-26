import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

test("docs delta runs without write lock when --patch is omitted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-docs-delta-lock-"));
  const storeDir = ".ato";
  await writeFile(
    path.join(root, storeDir, "config.json"),
    JSON.stringify(
      {
        version: 1,
        targetId: "tmp",
        storeDir,
        fingerprintSeed: "seed",
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
  );
  await writeFile(
    path.join(root, "src", "core", "capability", "manifest.ts"),
    "export const CAPABILITIES = [];\n",
  );
  await writeFile(path.join(root, "README.md"), "# Test\n");
  await writeFile(path.join(root, "docs", "USER_GUIDE.md"), "# Guide\n");

  const lockPayload = {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  await writeFile(
    path.join(root, storeDir, "lock.json"),
    `${JSON.stringify(lockPayload, null, 2)}\n`,
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "docs", "delta", "--json"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
});
