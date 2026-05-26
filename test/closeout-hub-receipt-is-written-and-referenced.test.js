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

const setupRepo = async ({ root, contractDoc, items }) => {
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: `closeout-${path.basename(root)}`,
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);
  await fs.mkdir(path.join(root, storeDir, "queue"), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(
    path.join(root, storeDir, "queue", "items.jsonl"),
    output.length ? `${output}\n` : "",
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

test("closeout apply writes a hub receipt and references it", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-dest-"));
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  const sourceItem = {
    id: "BL-0001",
    title: "Eligible item",
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
    origin: {
      repo_remote: "https://example.com/closeout.git",
      commit: "abc1234",
    },
    spec: {
      problem: "Problem",
      outcome: "Outcome",
      plan: {
        steps: ["Complete work"],
      },
      acceptance_criteria: ["cmd:seed"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/session.ts"],
      scope: ["src/cli/commands/session.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  const destSeed = {
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
      problem: "Seed.",
      outcome: "Seed.",
      plan: {
        steps: ["Seed destination queue"],
      },
      acceptance_criteria: ["cmd:seed"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/session.ts"],
      scope: ["src/cli/commands/session.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  await setupRepo({ root: sourceRoot, contractDoc, items: [sourceItem] });
  await setupRepo({ root: destRoot, contractDoc, items: [destSeed] });
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
      "session",
      "closeout",
      "apply",
      "--dest",
      destRoot,
      "--allow-cross-store-write",
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const receiptPath = payload.result.receipt.path;
  const receiptFullPath = path.join(destRoot, receiptPath);
  const receiptRaw = await fs.readFile(receiptFullPath, "utf8");
  const receipt = JSON.parse(receiptRaw);
  assert.equal(receipt.closeout_apply_sha256, payload.sha256);
  assert.ok(receipt.mapping);

  const destItemsPath = path.join(destRoot, ".ato", "queue", "items.jsonl");
  const destItems = await readQueueItems(destItemsPath);
  const transferredId = payload.result.mapping["BL-0001"];
  const transferred = destItems.find((item) => item.id === transferredId);
  assert.ok(transferred);
  assert.ok(transferred.notes.includes(receiptPath));
});
