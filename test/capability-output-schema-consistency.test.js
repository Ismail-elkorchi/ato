import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, values) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = values.map((value) => JSON.stringify(value));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
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
      title: "Output schema consistency",
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
        problem: "schema consistency",
        outcome: "metadata matches runtime envelope",
        plan: { steps: ["explain capability", "run queue command"] },
        acceptance_criteria: ["cmd:node --test"],
        inputs: ["output:seed"],
        deliverables: ["schema mapping"],
        scope: [],
        risks: [],
        contract_refs: [],
        runbook: [],
      },
    },
  ]);
};

const runJsonCommand = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};

test("queue capability output_schema matches queue JSON envelope schema_version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-capability-output-schema-"));
  try {
    await seedRepo(root);

    const listCapability = runJsonCommand(root, ["capability", "explain", "q.list"]);
    const listPayload = runJsonCommand(root, ["q", "list"]);
    assert.equal(listCapability.entry.output_schema, "queue-list.v1");
    assert.equal(listPayload.schema_version, listCapability.entry.output_schema);

    const validateCapability = runJsonCommand(root, [
      "capability",
      "explain",
      "q.validate",
    ]);
    const validatePayload = runJsonCommand(root, ["q", "validate"]);
    assert.equal(validateCapability.entry.output_schema, "queue-validate.v1");
    assert.equal(
      validatePayload.schema_version,
      validateCapability.entry.output_schema,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
