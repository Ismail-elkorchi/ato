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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-add-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-add-seed",
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

const runAdd = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(
    process.execPath,
    [cliPath, "--json", "q", "add", "block-0007: q add test", ...args],
    { cwd: root, encoding: "utf8" },
  );
};

const buildBaseArgs = (contractDoc) => [
  "--type",
  "feature",
  "--queue-target",
  "range:0.1.x",
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
];

test("q add rejects missing --outcome", async () => {
  const { root, contractDoc } = await setupRepo();
  const baseArgs = buildBaseArgs(contractDoc);
  const args = baseArgs.filter((value, index, list) => {
    if (value === "--outcome") return false;
    return list[index - 1] !== "--outcome";
  });
  const result = runAdd(root, args);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.message, "Missing required spec fields.");
  assert.ok(payload.error?.details?.missing?.includes("outcome"));
});

test("q add rejects missing --plan-steps", async () => {
  const { root, contractDoc } = await setupRepo();
  const baseArgs = buildBaseArgs(contractDoc);
  const args = baseArgs.filter((value, index, list) => {
    if (value === "--plan-steps") return false;
    return list[index - 1] !== "--plan-steps";
  });
  const result = runAdd(root, args);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.message, "Missing required spec fields.");
  assert.ok(payload.error?.details?.missing?.includes("plan-steps"));
});
