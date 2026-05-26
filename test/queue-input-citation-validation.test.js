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
  await fs.writeFile(filePath, `${output}\n`, "utf8");
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

test("q validate rejects queued spec.inputs entries without citation prefixes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-input-citation-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-input-citation-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 1.1 Citation Rule\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [
    {
      id: "BL-0001",
      title: "Input citations must be explicit",
      type: "tooling",
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
        problem: "validator accepts non-citation inputs",
        outcome: "validator rejects non-citation inputs",
        plan: { steps: ["validate"] },
        acceptance_criteria: ["cmd:ato q validate --json"],
        inputs: ["docs/USER_GUIDE.md", "file:.ato/contracts/PLATFORM_CONTRACT.md"],
        deliverables: ["validation error"],
        scope: [],
        risks: [],
        contract_refs: [{ doc: contractDoc, section: "1.1" }],
        runbook: [],
      },
    },
  ]);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.schema_version, "queue-validate.v1");
  const citationError = payload.errors.find((entry) =>
    String(entry.message).includes(
      "/spec/inputs/0 inputs must include an evidence citation",
    ),
  );
  assert.ok(citationError, JSON.stringify(payload.errors, null, 2));
  assert.equal(citationError.details?.instance_path, "/spec/inputs/0");
});

test("q validate rejects queued spec.inputs note: entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-input-note-prefix-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-input-note-prefix-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 1.1 Citation Rule\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [
    {
      id: "BL-0001",
      title: "Input citations must reject note prefix",
      type: "tooling",
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
        problem: "validator accepts note-prefixed inputs",
        outcome: "validator rejects note-prefixed inputs",
        plan: { steps: ["validate"] },
        acceptance_criteria: ["cmd:ato q validate --json"],
        inputs: ["note:manual-observation"],
        deliverables: ["validation error"],
        scope: [],
        risks: [],
        contract_refs: [{ doc: contractDoc, section: "1.1" }],
        runbook: [],
      },
    },
  ]);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.schema_version, "queue-validate.v1");
  const citationError = payload.errors.find((entry) =>
    String(entry.message).includes(
      "/spec/inputs/0 inputs must include an evidence citation",
    ),
  );
  assert.ok(citationError, JSON.stringify(payload.errors, null, 2));
  assert.equal(citationError.details?.instance_path, "/spec/inputs/0");
});

test("q validate rejects absolute output:/log: citations in spec.inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-input-absolute-prefix-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "queue-input-absolute-prefix-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 1.1 Citation Rule\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [
    {
      id: "BL-0001",
      title: "Input citations must reject absolute output/log paths",
      type: "tooling",
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
        problem: "validator accepts absolute output/log citations",
        outcome: "validator rejects absolute output/log citations",
        plan: { steps: ["validate"] },
        acceptance_criteria: ["cmd:ato q validate --json"],
        inputs: ["output:/tmp/proof.log", "log:/var/tmp/proof.log"],
        deliverables: ["validation error"],
        scope: [],
        risks: [],
        contract_refs: [{ doc: contractDoc, section: "1.1" }],
        runbook: [],
      },
    },
  ]);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.schema_version, "queue-validate.v1");
  const absoluteErrors = payload.errors.filter((entry) =>
    String(entry.message).includes("citation path must be repo-relative"),
  );
  assert.ok(absoluteErrors.length >= 2, JSON.stringify(payload.errors, null, 2));
});
