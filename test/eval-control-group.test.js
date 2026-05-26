import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSelectionEvidence, selectControlGroup } from "../dist/core/eval/select.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

const makeQueueItem = ({ id, status, evidence, inputs, title }) => ({
  id,
  title: title ?? `title-${id}`,
  type: "tooling",
  status,
  priority: "P2",
  tags: [],
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  target: { selector: "range", value: "0.1.x" },
  deps: [],
  evidence,
  owner: "agent",
  notes: "",
  spec: {
    problem: "problem",
    outcome: "outcome",
    plan: {
      steps: ["step"],
    },
    acceptance_criteria: ["cmd:echo ok"],
    inputs,
    deliverables: ["deliverable"],
    scope: [],
    risks: [],
    contract_refs: ["6.2 Ticket minimum fields"],
    runbook: [],
  },
});

const makeCycles = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `CY-${String(index + 1).padStart(4, "0")}`,
    ts: `2025-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    hypothesis: "control-group cadence",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["output:ok"],
  }));

const expectedPick = (seed, ids) => {
  const hashed = ids.map((id) => ({
    id,
    hash: crypto.createHash("sha256").update(`${seed}:${id}`).digest("hex"),
  }));
  hashed.sort((a, b) => {
    const diff = a.hash.localeCompare(b.hash);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
  return hashed[0].id;
};

test("eval cycle select enforces cadence and deterministic control-group pick", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-select-"));
  const storeDir = ".ato";

  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  await writeJson(path.join(root, storeDir, "meta", "blocks", "block-0001.json"), {
    version: 1,
    blockId: "block-0001",
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles: 5,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
    },
  });

  const items = [
    makeQueueItem({
      id: "BL-0001",
      status: "queued",
      evidence: [],
      inputs: ["output:one"],
      title: "Block-0001 control-group seed",
    }),
    makeQueueItem({
      id: "BL-0002",
      status: "queued",
      evidence: ["output:two"],
      inputs: [],
      title: "Block-0002 cross-block item",
    }),
    makeQueueItem({
      id: "BL-0003",
      status: "done",
      evidence: ["output:three"],
      inputs: [],
      title: "Block-0001 done item",
    }),
  ];
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), items);

  await writeJsonl(path.join(root, storeDir, "eval", "ledger.jsonl"), makeCycles(3));
  const notDueSelection = await selectControlGroup({
    store: path.join(root, storeDir),
    targetId: "tmp",
  });
  const notDueEvidence = buildSelectionEvidence({
    mode: "random",
    selection: notDueSelection,
  });
  assert.equal(notDueSelection.due, false);
  assert.equal(notDueSelection.scope, "block");
  assert.equal(notDueEvidence.scope, "block");
  assert.ok(notDueSelection.selection?.queue_id);
  const expected = expectedPick("block-0001", ["BL-0001"]);
  assert.equal(notDueSelection.selection?.queue_id, expected);
  assert.equal(notDueSelection.candidates.total, 2);
  assert.equal(notDueSelection.candidates.eligible, 1);
  assert.deepEqual(notDueEvidence.excluded_by_reason, {
    out_of_scope: 1,
    status: 1,
    deps: 0,
    missing_evidence: 0,
  });

  await writeJsonl(path.join(root, storeDir, "eval", "ledger.jsonl"), makeCycles(4));
  const dueSelection = await selectControlGroup({
    store: path.join(root, storeDir),
    targetId: "tmp",
  });
  assert.equal(dueSelection.due, true);
  assert.equal(dueSelection.selection?.queue_id, expected);

  const repeatSelection = await selectControlGroup({
    store: path.join(root, storeDir),
    targetId: "tmp",
  });
  assert.equal(
    repeatSelection.selection?.queue_id,
    dueSelection.selection?.queue_id,
  );
});
