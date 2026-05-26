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

const writeAgents = async (root) => {
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
};

const writeConfig = async (root) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
    gates: {
      fast: [],
      full: {
        tests: {
          order: ["root"],
          root: [{ id: "ok", cmd: [process.execPath, "-e", "process.exit(0)"] }],
        },
      },
    },
  });
};

const writeContracts = async (root) => {
  const docPath = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await fs.mkdir(path.dirname(docPath), { recursive: true });
  await fs.writeFile(docPath, "# 1 Bootstrap\n", "utf8");
};

const baseQueueItem = {
  id: "BL-0001",
  title: "block-0011 bootstrap cycle item",
  type: "tooling",
  status: "queued",
  priority: "P2",
  tags: [],
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  target: { selector: "milestone", value: "bootstrap" },
  deps: [],
  evidence: [],
  owner: "agent",
  notes: "Summary. Evidence: output:seed",
  spec: {
    problem: "Need finish preflight checks.",
    outcome: "Preflight catches blockers before finish.",
    plan: {
      steps: ["Run cycle preflight-finish"],
      rationale: "Evidence: output:seed",
    },
    acceptance_criteria: [
      "cmd:node -e process.exit(0)",
      "cmd:ato cycle finish --json",
    ],
    inputs: ["output:seed"],
    deliverables: ["deliverable"],
    scope: ["bootstrap"],
    risks: [],
    contract_refs: ["1"],
    runbook: [],
  },
};

const initGit = (root) => {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
};

const commitAll = (root) => {
  const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
};

const listFilesRecursive = async (rootDir) => {
  const out = [];
  const visit = async (dir) => {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else {
        out.push(full);
      }
    }
  };
  await visit(rootDir);
  return out.sort((a, b) => a.localeCompare(b));
};

test("cycle preflight-finish is deterministic and read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-preflight-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [
    baseQueueItem,
  ]);
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };

  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  const cycleId = startPayload.cycle_id;
  assert.ok(cycleId);

  const okPreflight = spawnSync(
    process.execPath,
    [cliPath, "cycle", "preflight-finish", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(okPreflight.status, 0, okPreflight.stderr);
  const okPayload = JSON.parse(okPreflight.stdout.trim());
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.schema_version, "cycle-finish-preflight.v1");
  assert.equal(okPayload.cycle_id, cycleId);
  assert.equal(okPayload.queue_id, "BL-0001");
  assert.deepEqual(okPayload.issues, []);

  const queuePath = path.join(root, ".ato", "queue", "items.jsonl");
  await writeJsonl(queuePath, [
    {
        ...baseQueueItem,
        status: "active",
        spec: {
          ...baseQueueItem.spec,
          acceptance_criteria: ["cmd:node -e process.exit(0)"],
          inputs: ["output:/tmp/proof.log"],
        },
        updated_at: "2025-01-02T00:00:00.000Z",
      },
  ]);

  const cycleDir = path.join(root, ".ato", "cycles", cycleId);
  const statePath = path.join(root, ".ato", "state.json");
  const filesBefore = await listFilesRecursive(cycleDir);
  const stateBefore = await fs.readFile(statePath, "utf8");

  const repeatPreflight = spawnSync(
    process.execPath,
    [cliPath, "cycle", "preflight-finish", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(repeatPreflight.status, 0, repeatPreflight.stderr);
  const repeatPayload = JSON.parse(repeatPreflight.stdout.trim());
  assert.equal(repeatPayload.ok, false);
  const issueCodes = repeatPayload.issues.map((issue) => issue.code).sort();
  assert.ok(issueCodes.includes("INVALID_INPUT_CITATION"));
  assert.ok(issueCodes.includes("MISSING_CYCLE_FINISH_ACCEPTANCE"));

  const filesAfter = await listFilesRecursive(cycleDir);
  const stateAfter = await fs.readFile(statePath, "utf8");
  assert.deepEqual(filesAfter, filesBefore);
  assert.equal(stateAfter, stateBefore);
});

test("cycle preflight-finish suggests q list for missing queue item diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-preflight-missing-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [baseQueueItem]);
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };

  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  assert.ok(startPayload.cycle_id);

  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), []);

  const preflight = spawnSync(
    process.execPath,
    [cliPath, "cycle", "preflight-finish", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(preflight.status, 0, preflight.stderr);
  const payload = JSON.parse(preflight.stdout.trim());
  assert.equal(payload.ok, false);
  const missingItem = payload.issues.find((issue) => issue.code === "MISSING_QUEUE_ITEM");
  assert.ok(missingItem, JSON.stringify(payload.issues, null, 2));
  assert.ok(Array.isArray(missingItem.suggested_commands));
  assert.ok(missingItem.suggested_commands.includes("ato q list --json"));
  assert.equal(missingItem.suggested_commands.includes("ato q view --json"), false);
});
