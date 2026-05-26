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
  });
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

const writeBlock = async (root) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0011.json"), {
    version: 1,
    blockId: "block-0011",
    cyclesPlanned: 1,
    baseline: { tag: "baseline_block0004_v0" },
  });
};

const makeQueueItem = ({ id, title }) => ({
  id,
  title,
  type: "tooling",
  status: "done",
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
    problem: "problem",
    outcome: "outcome",
    plan: {
      steps: ["step"],
    },
    acceptance_criteria: ["cmd:echo ok"],
    inputs: ["file:AGENTS.md"],
    deliverables: ["deliverable"],
    scope: [],
    risks: [],
    contract_refs: ["§1"],
    runbook: [],
  },
});

const writeQueue = async (root) => {
  const items = [
    makeQueueItem({ id: "BL-0001", title: "block-0011 done item 1" }),
    makeQueueItem({ id: "BL-0002", title: "block-0011 done item 2" }),
  ];
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), items);
};

const writeCycleLedger = async (root) => {
  await writeJsonl(path.join(root, ".ato", "cycles", "ledger.jsonl"), [
    {
      schema_version: "cycle-record.v1",
      id: "CY-0001",
      ts: "2025-01-01T00:00:00.000Z",
      block_id: "block-0011",
      cycle_index: 1,
      hypothesis: "block exhausted",
      acceptance_checks: ["cmd:echo ok"],
      evidence: ["file:AGENTS.md"],
      outcome: "ok",
      selection_evidence: {
        mode: "queue",
        cycle_id: "CY-0001",
        cycle_index: 1,
        scope: "block",
        seed: {
          source: "blockId",
          value: "block-0011",
          block_id: "block-0011",
        },
        candidates: { total: 1, eligible: 1 },
        excluded_by_reason: {
          out_of_scope: 0,
          status: 0,
          deps: 0,
          missing_evidence: 0,
        },
        selection: {
          queue_id: "BL-0001",
          hash: "0".repeat(64),
        },
      },
      gate_evidence: { mode: "full", result: { ok: true } },
      preflight_evidence: { path: "AGENTS.md", sha256: "0".repeat(64) },
      checks: [],
    },
  ]);
};

test("status reports block exhaustion transition when block-0011 is fully recorded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-block-exhausted-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBlock(root);
  await writeQueue(root);
  await writeCycleLedger(root);
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "status.v2");
  assert.equal(payload.selected_queue_id, null);
  assert.equal(payload.next_action_state, "block_exhaustion");
  assert.equal(payload.next_action_reason, "block_cycles_planned_reached");
  assert.deepEqual(payload.block_exhaustion, {
    block_id: "block-0011",
    cycles_planned: 1,
    cycles_recorded: 1,
    next_block_id: "block-0012",
    recommended_commands: [
      "ato block close --block-id block-0011 --json",
      "ato block open --block-id block-0012 --baseline baseline_block0004_v0 --json",
    ],
  });
  assert.equal(
    payload.next_action,
    "ato block close --block-id block-0011 --json && ato block open --block-id block-0012 --baseline baseline_block0004_v0 --json",
  );
  assert.ok(
    payload.agent_instructions.some((line) =>
      line.includes("Block block-0011 is exhausted (1/1)."),
    ),
  );
});
