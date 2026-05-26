import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: `closeout-${path.basename(root)}`,
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
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

const initGitRepo = async (root) => {
  const run = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "closeout apply\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["remote", "add", "origin", "https://example.com/closeout-apply.git"]);
};

const readQueueItems = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

test("session closeout apply returns mapping and stores result artifact", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-dest-"));
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  await initGitRepo(sourceRoot);

  const sourceItems = [
    {
      id: "BL-0001",
      title: "Queued item",
      type: "feature",
      status: "queued",
      priority: "P2",
      tags: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      target: { selector: "range", value: "range:0.1.x" },
      deps: [],
      evidence: ["file:seed.txt"],
      owner: "agent",
      notes: "",
      spec: {
        problem: "Queued.",
        outcome: "Queue.",
        plan: {
          steps: ["Queue item"],
        },
        acceptance_criteria: ["cmd:seed"],
        inputs: ["file:seed.txt"],
        deliverables: ["src/cli/commands/session.ts"],
        scope: ["src/cli/commands/session.ts"],
        risks: [],
        contract_refs: ["6.2"],
        runbook: [],
      },
    },
    {
      id: "BL-0002",
      title: "Active item",
      type: "feature",
      status: "active",
      priority: "P1",
      tags: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      target: { selector: "range", value: "range:0.1.x" },
      deps: [],
      evidence: ["file:seed.txt"],
      owner: "agent",
      notes: "",
      spec: {
        problem: "Active.",
        outcome: "Active.",
        plan: {
          steps: ["Complete active item"],
        },
        acceptance_criteria: ["cmd:seed"],
        inputs: ["file:seed.txt"],
        deliverables: ["src/cli/commands/session.ts"],
        scope: ["src/cli/commands/session.ts"],
        risks: [],
        contract_refs: ["6.2"],
        runbook: [],
      },
    },
  ];

  const destItems = [
    {
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
        deliverables: ["src/cli/commands/session.ts"],
        scope: ["src/cli/commands/session.ts"],
        risks: [],
        contract_refs: ["6.2"],
        runbook: [],
      },
    },
  ];

  await setupRepo({
    root: sourceRoot,
    contractDoc,
    items: sourceItems,
  });
  await setupRepo({
    root: destRoot,
    contractDoc,
    items: destItems,
  });
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
  assert.equal(payload.ok, true);
  assert.equal(payload.sha256, payload.artifact.sha256);
  assert.equal(payload.result.destination_target, destRoot);
  assert.deepEqual(
    payload.result.transfer_items.map((item) => item.id),
    ["BL-0001", "BL-0002"],
  );
  assert.ok(payload.result.mapping["BL-0001"]);
  assert.ok(payload.result.mapping["BL-0002"]);
  assert.equal(payload.result.audit.length, 2);
  assert.ok(payload.result.audit[0].source_repo_path);
  assert.ok(payload.result.audit[0].transfer_timestamp);

  const artifactPath = path.join(sourceRoot, payload.artifact.path);
  const artifactRaw = await fs.readFile(artifactPath, "utf8");
  const artifactHash = crypto
    .createHash("sha256")
    .update(artifactRaw)
    .digest("hex");
  assert.equal(payload.artifact.sha256, artifactHash);

  const destItemsPath = path.join(destRoot, ".ato", "queue", "items.jsonl");
  const destQueue = await readQueueItems(destItemsPath);
  const destIds = destQueue.map((item) => item.id);
  assert.ok(destIds.includes(payload.result.mapping["BL-0001"]));
  assert.ok(destIds.includes(payload.result.mapping["BL-0002"]));
});
