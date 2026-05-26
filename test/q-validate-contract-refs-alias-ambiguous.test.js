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

const writeContractIndex = async (root, storeDir, docs) => {
  const mapped = docs.map((doc) => ({
    path: path.relative(root, doc).replace(/\\/g, "/"),
    absPath: doc,
  }));
  const index = await buildContractIndex(mapped);
  await fs.mkdir(path.join(root, storeDir, "cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "cache", "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
};

test("q validate rejects ambiguous contract ref alias with candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-contract-alias-ambiguous-"));
  const storeDir = ".ato";
  const contractDocA = path.join(root, storeDir, "contracts", "DOC_A.md");
  const contractDocB = path.join(root, storeDir, "contracts", "DOC_B.md");

  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-contract-alias-ambiguous-seed",
    contracts: [contractDocA, contractDocB],
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDocA), { recursive: true });
  await fs.writeFile(contractDocA, "# A\n\n## 1 Determinism\n", "utf8");
  await fs.writeFile(contractDocB, "# B\n\n## 1 Determinism\n", "utf8");
  await writeContractIndex(root, storeDir, [contractDocA, contractDocB]);

  const item = {
    id: "BL-0004",
    title: "Ambiguous contract ref alias",
    type: "tooling",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-02T00:00:00.000Z",
    updated_at: "2025-01-02T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "ambiguous alias",
      outcome: "reject ambiguous",
      plan: { steps: ["Fix contract refs"] },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["file:README.md"],
      deliverables: ["guidance"],
      scope: [],
      risks: [],
      contract_refs: ["1-determinism"],
      runbook: [],
    },
  };

  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [item]);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  const message = payload.errors.map((entry) => entry.message).join("\n");
  assert.ok(message.includes("Ambiguous contract ref alias 1-determinism"));
  const docRelA = path.relative(root, contractDocA).replace(/\\/g, "/");
  const docRelB = path.relative(root, contractDocB).replace(/\\/g, "/");
  assert.ok(message.includes(docRelA));
  assert.ok(message.includes(docRelB));
});
