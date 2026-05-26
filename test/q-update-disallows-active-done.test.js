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

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-status-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-status-seed",
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

  const item = {
    id: "BL-0001",
    title: "Queue update test",
    type: "feature",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Status bypass is possible.",
      outcome: "Queue update refuses active/done.",
      plan: {
        steps: ["Attempt invalid status change", "Verify refusal"],
      },
      acceptance_criteria: ["cmd:seed"],
      inputs: ["cmd:seed"],
      deliverables: ["deliverable"],
      scope: [],
      risks: [],
      contract_refs: ["§0"],
      runbook: [],
    },
  };

  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [item]);
  return root;
};

const assertDisallowed = (payload, status) => {
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "STATUS_TRANSITION_DISALLOWED");
  assert.equal(payload.details?.attempted_status, status);
  assert.deepEqual(payload.details?.allowed, ["queued", "blocked", "dropped"]);
  assert.ok(Array.isArray(payload.suggested_fix));
};

test("q update refuses status active", async () => {
  const root = await setupRepo();
  const cliPath = path.resolve("dist/cli/main.js");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--repo",
      root,
      "q",
      "update",
      "BL-0001",
      "--status",
      "active",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assertDisallowed(payload, "active");
});

test("q update refuses status done", async () => {
  const root = await setupRepo();
  const cliPath = path.resolve("dist/cli/main.js");

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--repo",
      root,
      "q",
      "update",
      "BL-0001",
      "--status",
      "done",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assertDisallowed(payload, "done");
});
