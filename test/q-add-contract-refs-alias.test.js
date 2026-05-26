import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildContractIndex } from "../dist/core/contracts/index.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeContractIndex = async (root, storeDir, contractDoc) => {
  const docRel = path.relative(root, contractDoc).replace(/\\/g, "/");
  const index = await buildContractIndex([{ path: docRel, absPath: contractDoc }]);
  await fs.mkdir(path.join(root, storeDir, "cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "cache", "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
};

const setupRepo = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-contract-refs-alias-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-contract-refs-alias-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(
    contractDoc,
    "# PLATFORM\n\n## 6.1 Ticket First Rule\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);
  return { root };
};

test("q add accepts contract ref alias id and anchor", async () => {
  const { root } = await setupRepo();
  const cliPath = path.resolve("dist/cli/main.js");

  const addResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "--json",
      "q",
      "add",
      "block-0009: contract refs alias",
      "--type",
      "tooling",
      "--queue-target",
      "range:0.1.x",
      "--priority",
      "P2",
      "--problem",
      "problem",
      "--outcome",
      "outcome",
      "--plan-steps",
      "step1|step2",
      "--acceptance",
      "cmd:echo ok",
      "--inputs",
      "file:README.md",
      "--deliverables",
      "deliverable",
      "--contract-refs",
      "6-1-ticket-first-rule-3,6-1-ticket-first-rule",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(addResult.status, 0, addResult.stderr);
  const payload = JSON.parse(addResult.stdout.trim());
  assert.equal(payload.ok, true);

  const validateResult = spawnSync(
    process.execPath,
    [cliPath, "--json", "q", "validate"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(validateResult.status, 0, validateResult.stderr);
  const validatePayload = JSON.parse(validateResult.stdout.trim());
  assert.equal(validatePayload.ok, true);
});
