import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

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
  await fs.writeFile(path.join(root, "README.md"), "closeout test\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["remote", "add", "origin", "https://example.com/closeout.git"]);
  const head = run(["rev-parse", "HEAD"]);
  return String(head.stdout).trim();
};

test("session closeout plan is deterministic and evidence-backed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "session-closeout",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  const head = await initGitRepo(root);

  const items = [
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
      id: "BL-0003",
      title: "Done item",
      type: "feature",
      status: "done",
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
        problem: "Done.",
        outcome: "Done.",
        plan: {
          steps: ["Complete item"],
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

  const gateRunPath = path.join(root, ".ato", "runs", "last-gate.json");
  await writeJson(gateRunPath, {
    ok: false,
    results: [
      { id: "lint", ok: false, status: "fail", command: "npm run lint" },
    ],
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const args = [
    cliPath,
    "session",
    "closeout",
    "plan",
    "--gate-run",
    gateRunPath,
    "--dest",
    "/tmp/ato-target",
    "--json",
  ];

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
  const plan = payload.plan;
  assert.equal(plan.schema_version, "session-closeout.v1");
  assert.deepEqual(plan.contracts_consulted, ["6.2"]);
  assert.equal(plan.destination_target, "/tmp/ato-target");
  assert.ok(plan.origin);
  assert.equal(plan.origin.commit, head);
  assert.equal(plan.origin.repo_remote, "https://example.com/closeout.git");
  assert.ok(plan.drafts.length > 0);
  assert.deepEqual(
    plan.transfer_items.map((item) => item.id),
    ["BL-0001", "BL-0002"],
  );
  for (const draft of plan.drafts) {
    for (const input of draft.spec.inputs) {
      assert.ok(!String(input).includes("/tmp/"));
    }
  }

  const artifactPath = path.join(root, payload.artifact.path);
  const artifactRaw = await fs.readFile(artifactPath, "utf8");
  const artifactHash = crypto
    .createHash("sha256")
    .update(artifactRaw)
    .digest("hex");
  assert.equal(payload.artifact.sha256, artifactHash);
});
