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
  const lines = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, `${lines}\n`, "utf8");
};

const makeItem = (overrides) => ({
  id: "BL-0001",
  title: "Queue list test",
  type: "feature",
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
    problem: "Need list output",
    outcome: "List output exists",
    plan: {
      steps: ["Run list", "Verify filters"],
    },
    acceptance_criteria: ["List command works."],
    inputs: ["Queue items exist."],
    deliverables: ["List output."],
    scope: [],
    risks: [],
    contract_refs: ["6.2 Ticket minimum fields"],
    runbook: [],
  },
  ...overrides,
});

test("q list filters by status, tag, and target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-queue-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });

  const items = [
    makeItem({
      id: "BL-0001",
      tags: ["cli", "dx"],
      target: { selector: "range", value: "range:0.1.x" },
    }),
    makeItem({
      id: "BL-0002",
      tags: ["cli"],
      target: { selector: "range", value: "0.1.x" },
    }),
    makeItem({
      id: "BL-0003",
      status: "done",
      tags: ["cli", "dx"],
      target: { selector: "range", value: "0.1.x" },
    }),
  ];
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), items);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "list",
      "--status",
      "queued",
      "--tag",
      "cli,dx",
      "--queue-target",
      "range:0.1.x",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "queue-list.v1");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0]?.id, "BL-0001");
  assert.ok(payload.items[0]?.title);
  assert.ok(payload.items[0]?.status);
  assert.ok(payload.items[0]?.priority);
  assert.ok(Array.isArray(payload.items[0]?.tags));
  assert.ok(payload.items[0]?.target);
});
