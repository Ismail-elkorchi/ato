import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectControlGroup } from "../dist/core/eval/select.js";

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

test("selection due=true with no eligible items is a hard fail", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-select-due-empty-"));
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
      inputs: [],
      title: "Block-0001 queued no evidence",
    }),
  ];
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), items);
  await writeJsonl(path.join(root, storeDir, "eval", "ledger.jsonl"), makeCycles(4));

  try {
    await selectControlGroup({
      store: path.join(root, storeDir),
      targetId: "tmp",
    });
    assert.fail("Expected selection error.");
  } catch (error) {
    const details = error?.details ?? {};
    assert.equal(details.candidates_total, 1);
    assert.equal(details.candidates_eligible, 0);
    assert.equal(details.policy_source, "block");
    assert.equal(details.scope, "block");
    assert.equal(details.due, true);
  }
});
