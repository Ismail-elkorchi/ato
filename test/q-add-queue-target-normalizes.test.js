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

const readJsonl = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const setupRepo = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-add-target-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-add-target-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 0 Purpose\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);
  return { root, contractDoc };
};

test("q add normalizes range target inputs", async () => {
  const { root, contractDoc } = await setupRepo();
  const cliPath = path.resolve("dist/cli/main.js");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--json",
      "q",
      "add",
      "block-0009: q add target normalize",
      "--type",
      "feature",
      "--queue-target",
      "range:range:0.1.x",
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
      JSON.stringify([{ doc: contractDoc, section: "0" }]),
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const items = await readJsonl(path.join(root, ".ato", "queue", "items.jsonl"));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.target?.selector, "range");
  assert.equal(items[0]?.target?.value, "0.1.x");
});
