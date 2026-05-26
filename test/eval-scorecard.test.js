import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvalCycle } from "../dist/core/eval/ledger.js";

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

test("eval cycle record appends ledger and updates scorecard", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-"));
  const storeDir = ".ato";
  const store = path.join(root, storeDir);
  await writeJsonl(path.join(store, "eval", "ledger.jsonl"), []);

  const artifactPath = path.join(root, "artifacts", "gate.log");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "gate ok", "utf8");
  const artifactHash = await hashFile(artifactPath);

  const record = {
    id: "CY-0001",
    ts: "2025-01-01T00:00:00.000Z",
    cycle_index: 1,
    hypothesis: "Cycle ledger records outcomes.",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["output:ok"],
    outcome: "ok",
    negative_report: {
      type: "cost",
      summary: "Runtime cost captured.",
      evidence: ["output:ok"],
    },
    seeding_result: {
      outcome: "no_seed",
      summary: "no seed",
      evidence: ["output:ok"],
    },
    selection_evidence: {
      mode: "queue",
      cycle_id: "CY-0001",
      cycle_index: 1,
      scope: "block",
      seed: { source: "blockId", value: "block-0001", block_id: "block-0001" },
      candidates: { total: 1, eligible: 1 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 0,
        deps: 0,
        missing_evidence: 0,
      },
      selection: { queue_id: "BL-0001", hash: "0".repeat(64) },
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      artifacts: [
        {
          path: path.relative(root, artifactPath).replace(/\\/g, "/"),
          sha256: artifactHash,
        },
      ],
    },
    preflight_evidence: {
      path: ".ato/cycles/CY-0001/preflight.json",
      sha256: "0".repeat(64),
    },
    checks: [
      {
        id: "check-1",
        command: "echo ok",
        status: "ok",
        exitCode: 0,
        durationMs: 1,
      },
    ],
  };

  await appendEvalCycle({ store, record });

  const ledgerPath = path.join(store, "eval", "ledger.jsonl");
  const ledgerRaw = await fs.readFile(ledgerPath, "utf8");
  const ledgerEntries = ledgerRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].id, "CY-0001");

  const scorecardPath = path.join(store, "eval", "scorecard.json");
  const scorecard = JSON.parse(await fs.readFile(scorecardPath, "utf8"));
  assert.equal(scorecard.cycles, 1);
  assert.equal(scorecard.outcomes.ok, 1);
  assert.equal(scorecard.checks.total, 1);
});
