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

const setupRepo = async ({ root, contractDoc, seedItems }) => {
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: `queue-transfer-all-${path.basename(root)}`,
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
    `${seedItems.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
};

const readQueueItems = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

test("q transfer --all writes all valid items with audit metadata", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-dest-"));
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  const sourceItemA = {
    id: "BL-0001",
    title: "Source item A",
    type: "feature",
    status: "queued",
    priority: "P1",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.2.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "source A",
    spec: {
      problem: "Transfer A.",
      outcome: "Batch transfer ok.",
      plan: {
        steps: ["Transfer all", "Verify A"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q transfer --all"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  const sourceItemB = {
    id: "BL-0002",
    title: "Source item B",
    type: "feature",
    status: "active",
    priority: "P1",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.3.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "source B",
    spec: {
      problem: "Transfer B.",
      outcome: "Batch transfer ok.",
      plan: {
        steps: ["Transfer all", "Verify B"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q transfer --all"],
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
    title: "Dest seed",
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

  await setupRepo({
    root: sourceRoot,
    contractDoc,
    seedItems: [sourceItemA, sourceItemB],
  });
  await setupRepo({ root: destRoot, contractDoc, seedItems: [destItem] });
  await writeJson(path.join(sourceRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: destRoot, id: "tmp" }],
  });
  await writeJson(path.join(destRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "tmp" }],
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "transfer",
      "--all",
      "--dest",
      destRoot,
      "--allow-cross-store-write",
      "--source",
      sourceRoot,
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "batch");
  assert.equal(payload.mapping["BL-0001"], "BL-0002");
  assert.equal(payload.mapping["BL-0002"], "BL-0003");
  assert.equal(payload.counts.selected, 2);
  assert.equal(payload.counts.transferred, 2);

  const itemsPath = path.join(destRoot, ".ato", "queue", "items.jsonl");
  const items = await readQueueItems(itemsPath);
  assert.equal(items.length, 3);

  const transferredA = items.find((entry) => entry.id === "BL-0002");
  const transferredB = items.find((entry) => entry.id === "BL-0003");
  assert.ok(transferredA);
  assert.ok(transferredB);
  assert.ok(transferredA.notes.includes(`source_repo_path=${sourceRoot}`));
  assert.ok(transferredA.notes.includes("source_item_id=BL-0001"));
  assert.ok(transferredA.notes.includes("transfer_timestamp="));
  assert.ok(transferredB.notes.includes(`source_repo_path=${sourceRoot}`));
  assert.ok(transferredB.notes.includes("source_item_id=BL-0002"));
  assert.ok(transferredB.notes.includes("transfer_timestamp="));
});
