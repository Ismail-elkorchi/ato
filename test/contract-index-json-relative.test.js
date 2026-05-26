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

test("contract index JSON output uses repo-relative paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-contract-index-"));
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const storeDir = ".ato";
  const contractRel = ".ato/contracts/PLATFORM_CONTRACT.md";
  const contractAbs = path.join(root, contractRel);
  await fs.mkdir(path.dirname(contractAbs), { recursive: true });
  await fs.writeFile(contractAbs, "# PLATFORM\n\n## 0 Purpose\n", "utf8");

  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "contract-index-json",
    contracts: { platform: contractRel },
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "contract", "index", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(path.isAbsolute(payload.path), false);
  assert.ok(Array.isArray(payload.docs));
  for (const doc of payload.docs) {
    assert.equal(path.isAbsolute(doc), false);
  }
});
