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

test("q view prints item content by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-view-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "q-view-seed",
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);

  const item = {
    id: "BL-0001",
    title: "Queue view output",
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
      problem: "Queue view output is empty.",
      outcome: "Queue view prints a compact summary.",
      plan: {
        steps: ["Run q view"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q view"],
      inputs: ["file:docs/field-reports/ui-kit-ato-session-20251231.md"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  await fs.mkdir(path.join(root, storeDir, "queue"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "queue", "items.jsonl"),
    `${JSON.stringify(item)}\n`,
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "view"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("BL-0001"));
  assert.ok(result.stdout.includes("Queue view output"));
  assert.ok(result.stdout.includes("problem: Queue view output is empty."));
  assert.ok(result.stdout.includes("outcome: Queue view prints a compact summary."));
  assert.ok(result.stdout.includes("plan: 1 steps"));
});
