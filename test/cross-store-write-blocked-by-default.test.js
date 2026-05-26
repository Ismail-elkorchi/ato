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

test("cross-store writes are blocked without allowlist and flag", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cross-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cross-dest-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "cross-src",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(sourceRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(sourceRoot, storeDir, contractDoc);

  await writeJson(path.join(destRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "dest",
    storeDir,
    fingerprintSeed: "cross-dest",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(destRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(destRoot, storeDir, contractDoc);

  const sourceItem = {
    id: "BL-0001",
    title: "Source item",
    type: "feature",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Source item",
      outcome: "Blocked by cross-store safety",
      plan: {
        steps: ["Attempt transfer", "Observe refusal"],
      },
      acceptance_criteria: ["cmd:seed"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  await fs.mkdir(path.join(sourceRoot, storeDir, "queue"), { recursive: true });
  await fs.writeFile(
    path.join(sourceRoot, storeDir, "queue", "items.jsonl"),
    `${JSON.stringify(sourceItem)}\n`,
    "utf8",
  );

  const destItemsPath = path.join(destRoot, storeDir, "queue", "items.jsonl");
  await fs.mkdir(path.join(destRoot, storeDir, "queue"), { recursive: true });
  await fs.writeFile(destItemsPath, "", "utf8");
  const before = await fs.readFile(destItemsPath, "utf8");

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "transfer",
      "BL-0001",
      "--dest",
      destRoot,
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes("Cross-store write blocked by default"));
  const details = payload.error.details;
  assert.ok(details);
  assert.ok(details.source?.config_path);
  assert.ok(details.destination?.config_path);
  assert.ok(
    details.guidance?.some((line) => line.includes("--allow-cross-store-write")),
  );
  const allowlistGuidance = Array.isArray(details.guidance) ? details.guidance[0] : "";
  assert.ok(
    allowlistGuidance.includes(details.source.config_path) &&
      allowlistGuidance.includes(details.destination.config_path),
  );

  const after = await fs.readFile(destItemsPath, "utf8");
  assert.equal(after, before);
});
