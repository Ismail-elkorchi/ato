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

const setupRepo = async (seed) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-inputs-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: seed,
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
  return { root, contractDoc, storeDir };
};

const runAdd = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(
    process.execPath,
    [cliPath, "--json", "q", "add", "block-0009: q inputs glob", ...args],
    { cwd: root, encoding: "utf8" },
  );
};

test("q add rejects glob inputs", async () => {
  const { root, contractDoc } = await setupRepo("queue-inputs-glob-seed");
  const args = [
    "--type",
    "tooling",
    "--queue-target",
    "range:0.1.x",
    "--problem",
    "problem",
    "--outcome",
    "outcome",
    "--plan-steps",
    "step1|step2",
    "--acceptance",
    "cmd:echo ok",
    "--inputs",
    "file:test/*",
    "--deliverables",
    "deliverable",
    "--contract-refs",
    JSON.stringify([{ doc: contractDoc, section: "6.1" }]),
  ];
  const result = runAdd(root, args);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  const errors = payload.error?.details?.errors ?? [];
  const entry = errors.find(
    (err) =>
      err?.details?.instance_path === "/spec/inputs/0" ||
      String(err?.message ?? "").includes("/spec/inputs/0"),
  );
  assert.ok(entry, "expected input validation error with instance path");
  assert.ok(String(entry.message).includes("globs are not allowed"));
  assert.ok(String(entry.message).includes("file:test/*"));
  const guidance = entry?.details?.guidance ?? [];
  assert.ok(
    guidance.some((line) => line.includes("globs are not allowed")),
  );
  assert.equal(entry?.details?.example, "file:docs/USER_GUIDE.md");
});

test("q validate rejects glob inputs", async () => {
  const { root, contractDoc, storeDir } = await setupRepo(
    "queue-inputs-glob-validate-seed",
  );
  const item = {
    id: "BL-0005",
    title: "glob inputs",
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
      problem: "glob inputs",
      outcome: "reject",
      plan: { steps: ["Fix inputs"] },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["file:test/*"],
      deliverables: ["guidance"],
      scope: [],
      risks: [],
      contract_refs: [{ doc: contractDoc, section: "6.1" }],
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
  const entry = (payload.errors ?? []).find(
    (err) =>
      err?.details?.instance_path === "/spec/inputs/0" ||
      String(err?.message ?? "").includes("/spec/inputs/0"),
  );
  assert.ok(entry, "expected input validation error with instance path");
  assert.ok(String(entry.message).includes("globs are not allowed"));
  assert.ok(String(entry.message).includes("file:test/*"));
  const guidance = entry?.details?.guidance ?? [];
  assert.ok(
    guidance.some((line) => line.includes("globs are not allowed")),
  );
  assert.equal(entry?.details?.example, "file:docs/USER_GUIDE.md");
});

test("q validate rejects directory inputs", async () => {
  const { root, contractDoc, storeDir } = await setupRepo(
    "queue-inputs-dir-validate-seed",
  );
  await fs.mkdir(path.join(root, "evidence"), { recursive: true });
  const item = {
    id: "BL-0006",
    title: "dir inputs",
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
      problem: "dir inputs",
      outcome: "reject",
      plan: { steps: ["Fix inputs"] },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["file:evidence"],
      deliverables: ["guidance"],
      scope: [],
      risks: [],
      contract_refs: [{ doc: contractDoc, section: "6.1" }],
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
  const entry = (payload.errors ?? []).find(
    (err) =>
      err?.details?.instance_path === "/spec/inputs/0" ||
      String(err?.message ?? "").includes("/spec/inputs/0"),
  );
  assert.ok(entry, "expected input validation error with instance path");
  assert.ok(String(entry.message).includes("not a directory"));
  assert.ok(String(entry.message).includes("file:evidence"));
  const guidance = entry?.details?.guidance ?? [];
  assert.ok(
    guidance.some((line) => line.includes("file: inputs")),
  );
  assert.equal(entry?.details?.example, "file:docs/USER_GUIDE.md");
});

test("q validate accepts concrete file inputs", async () => {
  const { root, contractDoc, storeDir } = await setupRepo(
    "queue-inputs-concrete-validate-seed",
  );
  await fs.writeFile(path.join(root, "proof.txt"), "ok\n", "utf8");
  const item = {
    id: "BL-0007",
    title: "concrete inputs",
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
      problem: "concrete inputs",
      outcome: "accept",
      plan: { steps: ["Confirm inputs"] },
      acceptance_criteria: ["cmd:echo ok"],
      inputs: ["file:proof.txt"],
      deliverables: ["guidance"],
      scope: [],
      risks: [],
      contract_refs: [{ doc: contractDoc, section: "6.1" }],
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
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
});
