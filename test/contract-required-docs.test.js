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

test("contract compliance uses configured required docs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-contract-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
    contracts: {
      requiredDocs: ["docs/CUSTOM.md"],
    },
  });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "docs", "CUSTOM.md"),
    "Custom docs\n",
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "contract", "compliance", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(
    payload.report.docs.required.some((doc) => doc.endsWith("docs/CUSTOM.md")),
  );
});
