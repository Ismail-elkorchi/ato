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

test("contract extract resolves USER_OPTIMIZATION 2.2", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-contract-extract-"));
  const storeDir = ".ato";

  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const contractRel = ".ato/contracts/USER_OPTIMIZATION_CONTRACT.md";
  const contractAbs = path.join(root, contractRel);
  await fs.mkdir(path.dirname(contractAbs), { recursive: true });
  const sourceContract = path.resolve(".ato/contracts/USER_OPTIMIZATION_CONTRACT.md");
  const contractContent = await fs.readFile(sourceContract, "utf8");
  await fs.writeFile(contractAbs, contractContent, "utf8");

  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "contract-extract-user-optimization",
    contracts: { platform: contractRel },
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const index = spawnSync(
    process.execPath,
    [cliPath, "contract", "index", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(index.status, 0);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "contract",
      "extract",
      "--doc",
      ".ato/contracts/USER_OPTIMIZATION_CONTRACT.md",
      "--sections",
      "2.2",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.ok(
    payload.sections?.[0]?.content?.includes(
      "Writes MUST respect protocol + lock.",
    ),
  );
});
