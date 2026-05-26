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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-update-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-update-seed",
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
    tags: ["old", "cli"],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Queue updates are hard.",
      outcome: "Flags update fields.",
      plan: {
        steps: ["Update fields", "Validate output"],
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

test("q update flags apply deterministically", async () => {
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
      "--priority",
      "P0",
      "--status",
      "blocked",
      "--queue-target",
      "range:0.1.x",
      "--add-tag",
      "alpha",
      "--add-tag",
      "beta",
      "--remove-tag",
      "old",
      "--note",
      "first",
      "--note",
      "second",
      "--acceptance-add",
      "cmd:one",
      "--evidence-add",
      "file:proof.txt",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const queueRaw = await fs.readFile(
    path.join(root, ".ato", "queue", "items.jsonl"),
    "utf8",
  );
  const item = JSON.parse(queueRaw.trim());
  assert.equal(item.status, "blocked");
  assert.equal(item.priority, "P0");
  assert.equal(item.target.selector, "range");
  assert.equal(item.target.value, "0.1.x");
  assert.deepEqual(item.tags, ["alpha", "beta", "cli"]);
  assert.equal(item.notes, "first\nsecond");
  assert.deepEqual(item.spec.acceptance_criteria, ["cmd:seed", "cmd:one"]);
  assert.deepEqual(item.spec.inputs, ["cmd:seed", "file:proof.txt"]);
});

test("q update refuses conflicting acceptance flags", async () => {
  const root = await setupRepo();
  const cliPath = path.resolve("dist/cli/main.js");
  const acceptancePath = path.join(root, "acceptance.json");
  await writeJson(acceptancePath, ["cmd:a", "cmd:b"]);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--repo",
      root,
      "q",
      "update",
      "BL-0001",
      "--acceptance-set",
      `@${acceptancePath}`,
      "--acceptance-add",
      "cmd:c",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /acceptance-add|acceptance-set/);
});

test("q update rejects note-prefixed evidence additions", async () => {
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
      "--evidence-add",
      "note:manual-observation",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /Use file:, cmd:, log:, or output:/);
});
