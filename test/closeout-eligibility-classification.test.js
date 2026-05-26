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

test("closeout plan classifies eligible and ineligible items", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-classify-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "closeout-classify",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const items = [
    {
      id: "BL-0001",
      title: "Missing problem",
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
        problem: "",
        outcome: "Outcome",
        plan: {
          steps: ["Define problem"],
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
      title: "Eligible item",
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
      origin: {
        repo_remote: "https://example.com/closeout.git",
        commit: "abc1234",
      },
      spec: {
        problem: "Problem",
        outcome: "Outcome",
        plan: {
          steps: ["Complete work"],
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
      title: "Missing acceptance",
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
        problem: "Problem",
        outcome: "Outcome",
        plan: {
          steps: ["Complete work"],
        },
        acceptance_criteria: [],
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
  const result = spawnSync(
    process.execPath,
    [cliPath, "session", "closeout", "plan", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const plan = payload.plan;
  assert.equal(plan.eligible_items.length, 1);
  assert.equal(plan.eligible_items[0].id, "BL-0002");
  assert.equal(plan.ineligible_items.length, 2);
  assert.equal(plan.ineligible_items[0].id, "BL-0001");
  assert.ok(plan.ineligible_items[0].reasons.includes("missing spec.problem"));
  assert.ok(
    plan.ineligible_items[0].reasons.includes(
      "missing origin (producer repo identity unavailable)",
    ),
  );
  assert.equal(plan.ineligible_items[1].id, "BL-0003");
  assert.ok(
    plan.ineligible_items[1].reasons.includes(
      "missing spec.acceptance_criteria",
    ),
  );
});
