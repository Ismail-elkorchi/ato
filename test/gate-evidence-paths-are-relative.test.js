import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvalCycle, normalizeEvalCycleInput } from "../dist/core/eval/ledger.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const makeCycles = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `CY-${String(index + 1).padStart(4, "0")}`,
    ts: `2025-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    hypothesis: "seed",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["output:ok"],
    negative_report: {
      type: "cost",
      summary: "seed",
      evidence: ["output:ok"],
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      artifacts: [],
    },
  }));


test("gate evidence run_ref artifacts are recorded as repo-relative paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-gate-"));
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

  await writeJsonl(path.join(root, storeDir, "eval", "ledger.jsonl"), makeCycles(1));

  const preflightPath = path.join(root, storeDir, "cycles", "CY-0002", "preflight.json");
  await writeJson(preflightPath, { ok: true });
  const preflightSha = await hashFile(preflightPath);

  const artifactPath = path.join(
    root,
    storeDir,
    "runs",
    "artifacts",
    "global",
    "gate",
    "test.log",
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "gate ok", "utf8");

  const runLogPath = path.join(root, storeDir, "runs", "runs.jsonl");
  await writeJsonl(runLogPath, [
    {
      ts: "2025-01-01T00:00:00.000Z",
      kind: "gate_run",
      target_id: "tmp",
      mode: "full",
      commands: [{ cmd: "echo ok", cwd: root, exitCode: 0, durationMs: 1 }],
      artifacts: [artifactPath],
      summary: "gate ok",
    },
  ]);

  const record = {
    id: "CY-0002",
    ts: "2025-01-01T00:01:00.000Z",
    cycle_index: 2,
    hypothesis: "gate evidence normalized",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["output:ok"],
    outcome: "ok",
    negative_report: {
      type: "cost",
      summary: "none",
      evidence: ["output:ok"],
    },
    seeding_result: {
      outcome: "no_seed",
      summary: "no seeds",
      evidence: ["output:ok"],
    },
    selection_evidence: {
      mode: "random",
      due: false,
      cycle_id: "CY-0002",
      cycle_index: 2,
      cadence: 5,
      scope: "block",
      seed: { source: "blockId", value: "block-0001", block_id: null },
      candidates: { total: 1, eligible: 0 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 1,
        deps: 0,
        missing_evidence: 0,
      },
      selection: null,
    },
    gate_evidence: {
      mode: "full",
      run_ref: {
        path: runLogPath,
        line: 1,
      },
      result: { ok: true },
      artifacts: [{ path: artifactPath, sha256: await hashFile(artifactPath) }],
    },
    preflight_evidence: { path: preflightPath, sha256: preflightSha },
    checks: [],
  };

  const normalized = normalizeEvalCycleInput({
    input: record,
    fallbackId: "CY-0002",
    root,
  });
  await appendEvalCycle({
    store: path.join(root, storeDir),
    record: normalized,
  });

  const ledgerRaw = await fs.readFile(
    path.join(root, storeDir, "eval", "ledger.jsonl"),
    "utf8",
  );
  const lines = ledgerRaw.trim().split(/\r?\n/).filter(Boolean);
  const recorded = JSON.parse(lines[lines.length - 1]);
  assert.equal(path.isAbsolute(recorded.gate_evidence.run_ref.path), false);
  assert.equal(
    path.isAbsolute(recorded.gate_evidence.artifacts[0].path),
    false,
  );
});
