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

const writeQueue = async (root) => {
  const item = {
    id: "BL-0001",
    title: "Block-0005 queued item",
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
      problem: "problem",
      outcome: "outcome",
      plan: {
        steps: ["step"],
      },
      acceptance_criteria: ["cmd:node -e process.exit(0)"],
      inputs: ["output:seed"],
      deliverables: ["deliverable"],
      scope: [],
      risks: [],
      contract_refs: ["§0"],
      runbook: [],
    },
  };
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [item]);
};

const initGit = (root) => {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
};

test("status reports dirty tree guidance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-dirty-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeQueue(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.dirty_tree, true);
  assert.ok(Array.isArray(payload.dirty_paths));
  assert.ok(payload.dirty_paths.includes("AGENTS.md"));
  assert.match(payload.next_action, /clean working tree/i);
  assert.match(payload.next_action, /ato cycle start --json/);
  assert.equal(payload.next_action_state, "dirty_tree");
  assert.equal(payload.next_action_reason, "dirty_tree_requires_cleanup");
  assert.equal(payload.next_action_source, "status-transition-registry.v1");
  const untrackedHint = payload.agent_instructions.find((entry) =>
    /untracked files count as dirty too/i.test(entry),
  );
  assert.ok(untrackedHint);
  assert.match(untrackedHint, /AGENTS\.md/);
  assert.ok(!JSON.stringify(payload).includes(root));
});
