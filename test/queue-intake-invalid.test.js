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

test("q intake rejects invalid candidate without touching queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-intake-"));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-intake-src-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-intake-invalid",
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
    fingerprintSeed: "queue-intake-invalid-src",
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
    title: "Invalid intake",
    target: "range:0.1.x",
    spec: {
      problem: "Missing acceptance criteria.",
      outcome: "Validation must fail.",
      plan: {
        steps: ["Attempt intake", "Expect validation error"],
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
  const candidatePath = path.join(sourceRoot, "candidate.json");
  await writeJson(candidatePath, candidate);

  const before = await fs.readFile(itemsPath, "utf8");
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
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  const errors = payload.error?.details?.errors ?? [];
  assert.ok(errors.length > 0);
  const acceptanceError = errors.find(
    (entry) => entry.details?.instance_path === "/spec/acceptance_criteria",
  );
  assert.ok(acceptanceError);
  assert.ok(acceptanceError.details.schema_path);

  const after = await fs.readFile(itemsPath, "utf8");
  assert.equal(after, before);
});
