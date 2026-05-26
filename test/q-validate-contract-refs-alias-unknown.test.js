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

test("q validate rejects unknown contract ref alias with guidance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-contract-alias-unknown-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-contract-alias-unknown-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 6.1 Ticket First Rule\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);

  const item = {
    id: "BL-0003",
    title: "Unknown contract ref alias",
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
      problem: "unknown alias",
      outcome: "provide guidance",
      plan: { steps: ["Fix contract refs"] },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["file:README.md"],
      deliverables: ["guidance"],
      scope: [],
      risks: [],
      contract_refs: ["unknown-alias"],
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
  assert.ok(message.includes("Unresolved contract ref unknown-alias"));
  assert.ok(
    message.includes(
      'spec.contract_refs like [{"doc":"<doc-path>","section":"6.1"}]',
    ),
  );
});
