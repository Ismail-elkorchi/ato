import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendEvalCycle,
  validateEvalCycle,
} from "../dist/core/eval/ledger.js";
import { buildControlGroupExpectation } from "../dist/core/eval/select.js";
import {
  buildCycleEvidencePack,
  verifyCycleEvidencePack,
} from "../dist/core/eval/pack.js";

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

const makeBlock = async (store, { cadenceEveryNCycles = 1 } = {}) => {
  const blockPath = path.join(store, "meta", "blocks", "block-0001.json");
  await writeJson(blockPath, {
    version: 1,
    blockId: "block-0001",
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
    },
    holdout: {
      version: 1,
      tasks: [
        {
          id: "holdout-target-resolve",
          cmd: [process.execPath, "-e", "process.exit(0)"],
        },
      ],
    },
  });
};

const setupRepo = async ({ cadenceEveryNCycles = 1 } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-block-"));
  const store = path.join(root, ".ato");
  await writeJsonl(path.join(store, "eval", "ledger.jsonl"), []);
  await makeBlock(store, { cadenceEveryNCycles });
  return { root, store };
};

const makeArtifacts = async ({ store, includeHoldout }) => {
  const artifactsDir = path.join(store, "runs", "artifacts");
  const gatePath = path.join(artifactsDir, "test-1.log");
  await fs.mkdir(path.dirname(gatePath), { recursive: true });
  await fs.writeFile(gatePath, "gate ok", "utf8");
  const gateSha = await hashFile(gatePath);
  const artifacts = [{ path: path.relative(store, gatePath), sha256: gateSha }];

  if (includeHoldout) {
    const holdoutPath = path.join(artifactsDir, "holdout-target-resolve-1.log");
    await fs.writeFile(holdoutPath, "holdout ok", "utf8");
    const holdoutSha = await hashFile(holdoutPath);
    artifacts.unshift({
      path: path.relative(store, holdoutPath),
      sha256: holdoutSha,
    });
  }
  return artifacts;
};

const makeRecord = async ({
  root,
  store,
  expected,
  includeHoldout = true,
  controlGroup = true,
  controlGroupReason = "cadence",
}) => {
  const cycleId = expected.cycle_id;
  const cycleDir = path.join(store, "cycles", cycleId);
  const preflightPath = path.join(cycleDir, "preflight.json");
  await writeJson(preflightPath, { ok: true });
  const preflightSha = await hashFile(preflightPath);
  const selectionHash = crypto
    .createHash("sha256")
    .update(`seed:${cycleId}`)
    .digest("hex");
  const { pack_ref: packRef } = await buildCycleEvidencePack({
    root,
    store,
    cycleId,
    entries: [preflightPath],
  });
  const packVerifyResult = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
    requiredEntries: [],
  });
  const packVerifyPath = path.join(cycleDir, "pack-verify.json");
  await writeJson(packVerifyPath, packVerifyResult);
  const packVerifySha = await hashFile(packVerifyPath);

  const artifacts = await makeArtifacts({ store, includeHoldout });
  const artifactsRel = artifacts.map((artifact) => ({
    path: path.relative(root, path.join(store, artifact.path)).replace(/\\/g, "/"),
    sha256: artifact.sha256,
  }));
  const obligationsHash = crypto
    .createHash("sha256")
    .update("gate-obligations")
    .digest("hex");

  return {
    id: cycleId,
    ts: "2025-01-01T00:00:00.000Z",
    cycle_index: expected.cycle_index,
    queue_id: "BL-0001",
    hypothesis: "contract check",
    acceptance_checks: ["cmd:echo ok"],
    evidence: [`file:${path.relative(root, preflightPath).replace(/\\/g, "/")}`],
    outcome: "ok",
    negative_report: {
      type: "cost",
      summary: "cost noted",
      evidence: [`file:${path.relative(root, preflightPath).replace(/\\/g, "/")}`],
    },
    seeding_result: {
      outcome: "no_seed",
      summary: "no seed this cycle",
      evidence: [`file:${path.relative(root, preflightPath).replace(/\\/g, "/")}`],
    },
    ...(controlGroup ? { control_group: true } : {}),
    ...(controlGroupReason ? { control_group_reason: controlGroupReason } : {}),
    selection_evidence: {
      mode: "random",
      due: expected.due,
      cycle_id: expected.cycle_id,
      cycle_index: expected.cycle_index,
      cadence: expected.cadence,
      scope: expected.scope,
      seed: expected.seed,
      candidates: { total: 1, eligible: 1 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 0,
        deps: 0,
        missing_evidence: 0,
      },
      selection: { queue_id: "BL-0001", hash: selectionHash },
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      artifacts: artifactsRel,
      obligations_hash: obligationsHash,
    },
    preflight_evidence: {
      path: path.relative(root, preflightPath).replace(/\\/g, "/"),
      sha256: preflightSha,
    },
    pack_ref: packRef,
    pack_verify_ref: {
      kind: "pack_verify",
      cycle_id: cycleId,
      path: path.relative(root, packVerifyPath).replace(/\\/g, "/"),
      sha256: packVerifySha,
      ok: packVerifyResult.ok,
    },
    checks: [
      {
        id: "acceptance-01",
        command: "cmd:echo ok",
        status: "ok",
        exitCode: 0,
        durationMs: 1,
        artifacts: [],
      },
    ],
  };
};

test("validateEvalCycle rejects missing gate artifacts", async () => {
  const { root, store } = await setupRepo();
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({ root, store, expected });
  delete record.gate_evidence.artifacts;

  const result = await validateEvalCycle({
    record,
    expectedSelection: expected,
    root,
    store,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("gate_evidence")));
});

test("validateEvalCycle rejects missing negative_report", async () => {
  const { root, store } = await setupRepo();
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({ root, store, expected });
  delete record.negative_report;

  const result = await validateEvalCycle({
    record,
    expectedSelection: expected,
    root,
    store,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("negative_report")));
});

test("validateEvalCycle rejects control-group reason mismatch", async () => {
  const { root, store } = await setupRepo();
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({
    root,
    store,
    expected,
    controlGroupReason: "",
  });

  const result = await validateEvalCycle({
    record,
    expectedSelection: expected,
    root,
    store,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("control_group_reason")));
});

test("validateEvalCycle rejects control_group when not due", async () => {
  const { root, store } = await setupRepo({ cadenceEveryNCycles: 5 });
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({
    root,
    store,
    expected,
    controlGroup: true,
    controlGroupReason: "cadence",
  });

  const result = await validateEvalCycle({
    record,
    expectedSelection: expected,
    root,
    store,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("control_group")));
});

test("validateEvalCycle rejects holdout missing from gate artifacts", async () => {
  const { root, store } = await setupRepo();
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({
    root,
    store,
    expected,
    includeHoldout: false,
  });

  const result = await validateEvalCycle({
    record,
    expectedSelection: expected,
    root,
    store,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((entry) => entry.includes("holdout artifacts missing")),
  );
});

test("appendEvalCycle enforces append-only and supersedes", async () => {
  const { root, store } = await setupRepo();
  const expected = await buildControlGroupExpectation({
    store,
    targetId: "tmp",
  });
  const record = await makeRecord({ root, store, expected });

  await appendEvalCycle({ store, record });

  await assert.rejects(
    () => appendEvalCycle({ store, record }),
    /cycle id 'CY-0001' already exists/,
  );

  const superseding = await makeRecord({ root, store, expected });
  superseding.id = "CY-0002";
  superseding.supersedes = {
    id: "CY-9999",
    reason: "missing target",
    evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
  };
  await assert.rejects(
    () => appendEvalCycle({ store, record: superseding }),
    /supersedes target 'CY-9999' not found/,
  );
});
