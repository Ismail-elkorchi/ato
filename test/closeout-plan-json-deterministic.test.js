import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const initGitRepo = async (root) => {
  const run = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "closeout plan\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["remote", "add", "origin", "https://example.com/closeout-plan.git"]);
};

test("session closeout plan emits deterministic JSON and artifact hash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-plan-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "closeout-plan",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await initGitRepo(root);

  const items = [
    {
      id: "BL-0002",
      title: "Active item",
      type: "feature",
      status: "active",
      priority: "P1",
      tags: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      target: { selector: "range", value: "range:0.1.x" },
      deps: [],
      evidence: [],
      owner: "agent",
      notes: "",
      spec: {
        problem: "Active.",
        outcome: "Active.",
        plan: {
          steps: ["Complete active item"],
        },
        acceptance_criteria: ["cmd:seed"],
        inputs: ["file:seed.txt"],
        deliverables: ["src/cli/commands/session.ts"],
        scope: ["src/cli/commands/session.ts"],
        risks: [],
        contract_refs: ["6.2"],
        runbook: [],
      },
    },
    {
      id: "BL-0001",
      title: "Queued item",
      type: "feature",
      status: "queued",
      priority: "P2",
      tags: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      target: { selector: "range", value: "range:0.1.x" },
      deps: [],
      evidence: [],
      owner: "agent",
      notes: "",
      spec: {
        problem: "Queued.",
        outcome: "Queue.",
        plan: {
          steps: ["Queue item"],
        },
        acceptance_criteria: ["cmd:seed"],
        inputs: ["file:seed.txt"],
        deliverables: ["src/cli/commands/session.ts"],
        scope: ["src/cli/commands/session.ts"],
        risks: [],
        contract_refs: ["6.2"],
        runbook: [],
      },
    },
  ];
  await fs.mkdir(path.join(root, storeDir, "queue"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "queue", "items.jsonl"),
    items.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const args = [cliPath, "session", "closeout", "plan", "--json"];
  const first = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), first.stdout.trim());

  const payload = JSON.parse(first.stdout.trim());
  assert.equal(payload.ok, true);
  assert.ok(payload.plan);
  assert.deepEqual(
    payload.plan.transfer_items.map((item) => item.id),
    ["BL-0001", "BL-0002"],
  );

  const artifactPath = path.join(root, payload.artifact.path);
  const artifactRaw = await fs.readFile(artifactPath, "utf8");
  const artifactHash = crypto
    .createHash("sha256")
    .update(artifactRaw)
    .digest("hex");
  assert.equal(payload.artifact.sha256, artifactHash);
});
