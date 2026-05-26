import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Ajv from "ajv/dist/2020.js";

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

const loadStatusSchema = async () => {
  const schemaUrl = new URL("../dist/core/schemas/status.v2.json", import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

test("status emits deterministic git plan suggestions for dirty tree classes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-plan-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeQueue(root);
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
  commitAll(root);

  await fs.appendFile(path.join(root, "tracked.txt"), "delta\n", "utf8");
  await fs.writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
  await fs.writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");
  const stage = spawnSync("git", ["add", "staged.txt"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(stage.status, 0, stage.stderr);

  const cliPath = path.resolve("dist/cli/main.js");
  const first = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout.trim());

  const second = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout.trim());

  assert.deepEqual(secondPayload, firstPayload);
  assert.equal(firstPayload.ok, true);
  assert.equal(firstPayload.dirty_tree, true);
  assert.deepEqual(firstPayload.git_plan_suggestions, [
    {
      category: "staged",
      command: "ato git plan commit --json",
      rationale: "Staged changes detected; evaluate commit workflow options.",
      path_count: 1,
      alternatives: [],
    },
    {
      category: "unstaged_tracked",
      command: "ato git plan restore --json",
      rationale:
        "Unstaged tracked changes detected; evaluate restore-first or stage-and-commit path.",
      path_count: 1,
      alternatives: ["ato git plan commit --json"],
    },
    {
      category: "untracked",
      command: "ato git plan stash --json",
      rationale:
        "Untracked files detected; evaluate stash-first path before any clean operation.",
      path_count: 1,
      alternatives: ["ato git plan clean --json"],
    },
  ]);

  assert.ok(
    firstPayload.agent_instructions.includes(
      "Git plan (staged): ato git plan commit --json",
    ),
  );
  assert.ok(
    firstPayload.agent_instructions.includes(
      "Git plan (unstaged_tracked): ato git plan restore --json",
    ),
  );
  assert.ok(
    firstPayload.agent_instructions.includes(
      "Git plan (untracked): ato git plan stash --json",
    ),
  );
  assert.ok(!JSON.stringify(firstPayload).includes(root));

  const schema = await loadStatusSchema();
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(firstPayload), true, JSON.stringify(validate.errors, null, 2));
});
