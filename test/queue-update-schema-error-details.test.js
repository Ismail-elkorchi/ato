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

test("queue update schema errors include paths and allowed keys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-update-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-update-seed",
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
    title: "Schema error details",
    type: "bug",
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
      problem: "Queue update schema errors are opaque.",
      outcome: "Errors include paths and allowed keys.",
      plan: {
        steps: ["Trigger validation", "Inspect error output"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q update"],
      inputs: ["file:docs/field-reports/ui-kit-ato-session-20251231.md"],
      deliverables: ["src/core/queue/validate.ts"],
      scope: ["src/core/queue/validate.ts"],
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
    [
      cliPath,
      "q",
      "update",
      "BL-0001",
      "--input",
      '{"details":{"completion_summary":["oops"]}}',
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  const errors = payload.error?.details?.errors ?? [];
  const additional = errors.find(
    (entry) => entry.details?.keyword === "additionalProperties",
  );
  assert.ok(additional);
  assert.equal(additional.details.instance_path, "/details");
  assert.ok(additional.details.schema_path.includes("#/properties/details"));
  assert.equal(additional.details.unexpected_key, "completion_summary");
  assert.ok(Array.isArray(additional.details.allowed_keys));
  assert.ok(additional.details.allowed_keys.includes("rationale"));
});
