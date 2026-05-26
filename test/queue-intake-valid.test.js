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

const readQueueItems = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

test("q intake writes a validated queued item with audit notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-intake-"));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-intake-src-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-intake-valid",
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "queue-intake-source",
  });
  await fs.writeFile(
    path.join(sourceRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeJson(path.join(root, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "src" }],
  });
  await writeJson(path.join(sourceRoot, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root, id: "tmp" }],
  });
  await writeContractIndex(root, storeDir, contractDoc);

  const item = {
    id: "BL-0001",
    title: "Seed intake queue",
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
      problem: "Seed queue data.",
      outcome: "Queue exists for intake.",
      plan: {
        steps: ["Seed queue data"],
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

  const queueDir = path.join(root, storeDir, "queue");
  const itemsPath = path.join(queueDir, "items.jsonl");
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(itemsPath, `${JSON.stringify(item)}\n`, "utf8");

  const candidate = {
    title: "Cross-repo intake",
    type: "feature",
    priority: "P1",
    target: "0.2.x",
    notes: "seed note",
    tags: ["Queue", "CLI"],
    deps: ["BL-0001"],
    evidence: ["file:seed.txt"],
    spec: {
      problem: "Validated intake is missing.",
      outcome: "Queue intake accepts a candidate file.",
      plan: {
        steps: ["Validate candidate", "Write item"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q intake --file candidate.json"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };
  const candidatePath = path.join(sourceRoot, "candidate.json");
  await writeJson(candidatePath, candidate);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "intake",
      "--file",
      candidatePath,
      "--dest",
      root,
      "--allow-cross-store-write",
      "--telemetry-ref",
      "telemetry.json#L1",
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.id, "BL-0002");
  assert.equal(payload.title, candidate.title);
  assert.equal(payload.target, "range:0.2.x");

  const items = await readQueueItems(itemsPath);
  const intakeItem = items.find((entry) => entry.id === "BL-0002");
  assert.ok(intakeItem);
  assert.equal(intakeItem.status, "queued");
  assert.equal(intakeItem.priority, "P1");
  assert.deepEqual(intakeItem.tags, ["cli", "queue"]);
  assert.deepEqual(intakeItem.deps, ["BL-0001"]);
  assert.deepEqual(intakeItem.evidence, ["file:seed.txt"]);
  assert.equal(intakeItem.target.selector, "range");
  assert.equal(intakeItem.target.value, "0.2.x");
  assert.equal(intakeItem.spec.problem, candidate.spec.problem);
  assert.equal(intakeItem.spec.outcome, candidate.spec.outcome);
  assert.deepEqual(intakeItem.spec.plan, candidate.spec.plan);
  assert.deepEqual(
    intakeItem.spec.acceptance_criteria,
    candidate.spec.acceptance_criteria,
  );
  assert.equal(intakeItem.notes.startsWith("seed note\nIntake:"), true);
  assert.ok(intakeItem.notes.includes(`source_repo=${sourceRoot}`));
  assert.ok(intakeItem.notes.includes("ingested_at="));
  assert.ok(intakeItem.notes.includes("telemetry_ref=telemetry.json#L1"));
  assert.equal(intakeItem.created_at, intakeItem.updated_at);
});
