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

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

test("q validate requires contract_refs for queued items", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-queue-contract-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const item = {
    id: "BL-0001",
    title: "Contract refs required",
    type: "bug",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "contract refs missing",
      outcome: "contract refs required",
      plan: {
        steps: ["Provide contract refs"],
      },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["output:ok"],
      deliverables: ["queue validation"],
      scope: [],
      risks: [],
      contract_refs: [],
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
  assert.equal(result.status, 6);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.schema_version, "queue-validate.v1");
  assert.ok(
    payload.errors.some((entry) => entry.message.includes("spec.contract_refs")),
  );
});
