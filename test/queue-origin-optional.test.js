import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildContractIndex } from "../dist/core/contracts/index.js";
import { validateQueueItems } from "../dist/core/queue/validate.js";

const loadQueueSchema = async () => {
  const schemaUrl = new URL(
    "../dist/core/schemas/queue.v2.json",
    import.meta.url,
  );
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

test("queue items without origin remain valid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-origin-optional-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  const docRel = path.relative(root, contractDoc).replace(/\\/g, "/");
  const index = await buildContractIndex([{ path: docRel, absPath: contractDoc }]);
  await fs.mkdir(path.join(root, storeDir, "cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "cache", "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );

  const item = {
    id: "BL-0001",
    title: "Origin is optional",
    type: "tooling",
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
      problem: "Origin metadata is optional.",
      outcome: "Origin metadata remains optional.",
      plan: {
        steps: ["Validate without origin"],
      },
      acceptance_criteria: ["cmd:node --test"],
      inputs: ["output:seed"],
      deliverables: ["src/core/schemas/queue.v2.json"],
      scope: ["src/core/schemas/queue.v2.json"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  const schema = await loadQueueSchema();
  const validation = await validateQueueItems({
    items: [item],
    schema,
    config: { contracts: { platform: contractDoc } },
    root,
    store: path.join(root, storeDir),
  });

  assert.equal(validation.errors.length, 0);
});
