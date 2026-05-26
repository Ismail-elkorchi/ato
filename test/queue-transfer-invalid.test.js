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

const setupRepo = async ({ root, contractDoc, seedItem }) => {
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: `queue-transfer-${path.basename(root)}`,
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);
  const queueDir = path.join(root, storeDir, "queue");
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(
    path.join(queueDir, "items.jsonl"),
    `${JSON.stringify(seedItem)}\n`,
    "utf8",
  );
};

test("q transfer rejects invalid source item without writing destination", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-dest-"));
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  const invalidSourceItem = {
    id: "BL-0001",
    title: "Invalid source item",
    type: "feature",
    status: "queued",
    priority: "P1",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Acceptance criteria missing.",
      outcome: "Transfer should reject.",
      plan: {
        steps: ["Attempt transfer", "Expect validation error"],
      },
      acceptance_criteria: [],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  const destItem = {
    id: "BL-0001",
    title: "Destination seed",
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
      problem: "Seed dest.",
      outcome: "Queue exists.",
      plan: {
        steps: ["Seed destination queue"],
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

  await setupRepo({ root: sourceRoot, contractDoc, seedItem: invalidSourceItem });
  await setupRepo({ root: destRoot, contractDoc, seedItem: destItem });
  await writeJson(path.join(sourceRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: destRoot, id: "tmp" }],
  });
  await writeJson(path.join(destRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "tmp" }],
  });

  const destItemsPath = path.join(destRoot, ".ato", "queue", "items.jsonl");
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
      "--allow-cross-store-write",
      "--source",
      sourceRoot,
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  const errors = payload.error?.details?.errors ?? [];
  assert.ok(errors.length > 0);
  assert.ok(errors.some((entry) => entry.details?.instance_path));

  const after = await fs.readFile(destItemsPath, "utf8");
  assert.equal(after, before);
});
