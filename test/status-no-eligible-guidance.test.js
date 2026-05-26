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
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0006.json"), {
    version: 1,
    blockId: "block-0006",
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
    inputs: [],
    deliverables: ["deliverable"],
    scope: [],
    risks: [],
    contract_refs: ["§5"],
    runbook: [],
  },
});

const writeQueue = async (root) => {
  const items = [
    makeQueueItem({ id: "BL-0001", title: "Block-0006 done item 1" }),
    makeQueueItem({ id: "BL-0002", title: "Block-0006 done item 2" }),
    makeQueueItem({ id: "BL-0003", title: "Block-0006 done item 3" }),
  ];
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), items);
};

test("status returns ok with guidance when no eligible evidence-backed queue items exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-no-eligible-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBlock(root);
  await writeQueue(root);
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
  assert.equal("intent_summary" in payload, false);
  assert.equal(payload.selected_queue_id, null);
  assert.equal(payload.candidates_total, 3);
  assert.equal(payload.candidates_eligible, 0);
  assert.deepEqual(payload.excluded_by_reason, {
    out_of_scope: 0,
    status: 3,
    deps: 0,
    missing_evidence: 0,
  });
  assert.equal(
    payload.next_action,
    "Create a queued/active block-scoped evidence-backed item (title must include block-0006; include spec.outcome, spec.plan.steps, and spec.inputs/evidence).",
  );
  assert.equal(payload.next_action_state, "selection_failure");
  assert.equal(payload.next_action_reason, "no_eligible_block_scoped_items");
  assert.equal(payload.next_action_source, "status-transition-registry.v1");
  assert.ok(!payload.next_action.includes("Open next block"));
});
