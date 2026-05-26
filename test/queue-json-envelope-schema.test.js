import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createAjv } from "../dist/core/schemas/ajv.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, values) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = values.map((value) => JSON.stringify(value));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
};

const loadSchema = async (name) => {
  const raw = await fs.readFile(path.resolve("dist", "core", "schemas", name), "utf8");
  return JSON.parse(raw);
};

const seedRepo = async (root) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [
    {
      id: "BL-0001",
      title: "Queue json envelope schema",
      type: "contract",
      status: "dropped",
      priority: "P2",
      tags: ["queue", "schema"],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      target: { selector: "range", value: "0.1.x" },
      deps: [],
      evidence: [],
      owner: "agent",
      notes: "",
      spec: {
        problem: "json envelope drift",
        outcome: "schema-versioned output",
        plan: { steps: ["emit version", "validate output"] },
        acceptance_criteria: ["cmd:node --test"],
        inputs: ["output:seed"],
        deliverables: ["schema envelope"],
        scope: [],
        risks: [],
        contract_refs: [],
        runbook: [],
      },
    },
  ]);
};

test("q list and q validate json outputs satisfy versioned schemas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-queue-json-schema-"));
  await seedRepo(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const listResult = spawnSync(process.execPath, [cliPath, "q", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  const listPayload = JSON.parse(listResult.stdout.trim());
  assert.equal(listPayload.schema_version, "queue-list.v1");

  const validateResult = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(validateResult.status, 0, validateResult.stderr);
  const validatePayload = JSON.parse(validateResult.stdout.trim());
  assert.equal(validatePayload.schema_version, "queue-validate.v1");

  const ajv = createAjv({ allErrors: true });
  const listSchema = await loadSchema("queue-list.v1.json");
  const validateSchema = await loadSchema("queue-validate.v1.json");

  const validateList = ajv.compile(listSchema);
  const validateValidate = ajv.compile(validateSchema);

  assert.equal(validateList(listPayload), true, JSON.stringify(validateList.errors, null, 2));
  assert.equal(
    validateValidate(validatePayload),
    true,
    JSON.stringify(validateValidate.errors, null, 2),
  );
});
