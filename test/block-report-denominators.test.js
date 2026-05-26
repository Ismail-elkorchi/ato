import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  });
};

const writeBlock = async (
  root,
  { cyclesPlanned = 3, includeCyclesPlanned = true } = {},
) => {
  const block = {
    version: 1,
    blockId: "block-0005",
    frozen: true,
    baseline: { tag: "baseline-test" },
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles: 5,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
    },
    holdout: { version: 1, tasks: [] },
  };
  if (includeCyclesPlanned) {
    block.cyclesPlanned = cyclesPlanned;
  }
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), block);
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

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const setupReportFixture = async ({
  cyclesPlanned = 3,
  includeCyclesPlanned = true,
  recordSpecs,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-block-report-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBlock(root, { cyclesPlanned, includeCyclesPlanned });

  const cycleDir = path.join(root, ".ato", "cycles", "CY-0001");
  const preflightPath = path.join(cycleDir, "preflight.json");
  await writeJson(preflightPath, { ok: true });
  const preflightSha = await hashFile(preflightPath);

  const artifactPath = path.join(
    root,
    ".ato",
    "runs",
    "artifacts",
    "global",
    "gate",
    "test.log",
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "gate ok", "utf8");
  const artifactSha = await hashFile(artifactPath);

  const packRefs = {};
  const packVerifyRefs = {};
  for (const spec of recordSpecs) {
    const { pack_ref: packRef } = await buildCycleEvidencePack({
      root,
      store: path.join(root, ".ato"),
      cycleId: spec.id,
      entries: [preflightPath, artifactPath],
    });
    packRefs[spec.id] = packRef;
    const packVerifyResult = await verifyCycleEvidencePack({
      root,
      packPath: packRef.path,
      manifestPath: packRef.manifest_path,
      expectedPackSha: packRef.sha256,
      requiredEntries: [],
    });
    const packVerifyPath = path.join(
      root,
      ".ato",
      "cycles",
      spec.id,
      "pack-verify.json",
    );
    await writeJson(packVerifyPath, packVerifyResult);
    const packVerifySha = await hashFile(packVerifyPath);
    packVerifyRefs[spec.id] = {
      kind: "pack_verify",
      cycle_id: spec.id,
      path: path.relative(root, packVerifyPath).replace(/\\/g, "/"),
      sha256: packVerifySha,
      ok: packVerifyResult.ok,
    };
  }

  const recordBase = {
    hypothesis: "report test",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    negative_report: {
      type: "cost",
      summary: "cost",
      evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    },
    seeding_result: {
      outcome: "no_seed",
      summary: "no seed",
      evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    },
    selection_evidence: {
      mode: "random",
      due: false,
      cycle_id: "CY-0001",
      cycle_index: 1,
      cadence: 5,
      scope: "block",
      seed: { source: "blockId", value: "block-0005", block_id: "block-0005" },
      candidates: { total: 1, eligible: 1 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 0,
        deps: 0,
        missing_evidence: 0,
      },
      selection: {
        queue_id: "BL-0001",
        hash: crypto.createHash("sha256").update("x").digest("hex"),
      },
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      obligations_hash: crypto.createHash("sha256").update("gate").digest("hex"),
      artifacts: [
        { path: ".ato/runs/artifacts/global/gate/test.log", sha256: artifactSha },
      ],
    },
    preflight_evidence: {
      path: ".ato/cycles/CY-0001/preflight.json",
      sha256: preflightSha,
    },
    checks: [],
  };

  const makeRecord = ({ id, ts, cycleIndex, outcome, controlGroup }) => ({
    ...recordBase,
    id,
    ts,
    cycle_index: cycleIndex,
    outcome,
    pack_ref: packRefs[id],
    pack_verify_ref: packVerifyRefs[id],
    ...(controlGroup ? { control_group: true, control_group_reason: "cadence" } : {}),
    selection_evidence: {
      ...recordBase.selection_evidence,
      cycle_id: id,
      cycle_index: cycleIndex,
    },
  });

  const records = recordSpecs.map((spec) => makeRecord(spec));
  await writeJsonl(path.join(root, ".ato", "eval", "ledger.jsonl"), records);
  commitAll(root);

  return { root };
};

const writeBlockSeal = async (root, blockId = "block-0005") => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", `${blockId}.seal.json`), {
    schema_version: "block-seal.v1",
    block_id: blockId,
    obligations_hash: crypto.createHash("sha256").update("seal").digest("hex"),
    inputs: {
      adapter_id: "local",
      gate_plan: [],
      gate_config: {},
      holdout_tasks: [],
      overrides: {
        applied: false,
        targetId: "tmp",
        source: null,
        config: null,
      },
    },
  });
};

const writeBlockClosure = async ({
  root,
  blockId = "block-0005",
  reportPath,
  reportSha,
}) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", `${blockId}.closure.json`), {
    schema_version: "block-closure.v1",
    blockId,
    closed_at: "2025-01-01T00:05:00.000Z",
    report_ref: {
      path: reportPath,
      sha256: reportSha,
    },
  });
};

const runBlockClose = (root) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(
    process.execPath,
    [cliPath, "block", "close", "--block-id", "block-0005", "--json"],
    { cwd: root, encoding: "utf8" },
  );
};

test("block report counts ledger denominators", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-block-report-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBlock(root);

  const cycleDir = path.join(root, ".ato", "cycles", "CY-0001");
  const preflightPath = path.join(cycleDir, "preflight.json");
  await writeJson(preflightPath, { ok: true });
  const preflightSha = await hashFile(preflightPath);

  const artifactPath = path.join(
    root,
    ".ato",
    "runs",
    "artifacts",
    "global",
    "gate",
    "test.log",
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "gate ok", "utf8");
  const artifactSha = await hashFile(artifactPath);
  const packRefs = {};
  const packVerifyRefs = {};
  for (const cycleId of ["CY-0001", "CY-0002"]) {
    const { pack_ref: packRef } = await buildCycleEvidencePack({
      root,
      store: path.join(root, ".ato"),
      cycleId,
      entries: [preflightPath, artifactPath],
    });
    packRefs[cycleId] = packRef;
    const packVerifyResult = await verifyCycleEvidencePack({
      root,
      packPath: packRef.path,
      manifestPath: packRef.manifest_path,
      expectedPackSha: packRef.sha256,
      requiredEntries: [],
    });
    const packVerifyPath = path.join(
      root,
      ".ato",
      "cycles",
      cycleId,
      "pack-verify.json",
    );
    await writeJson(packVerifyPath, packVerifyResult);
    const packVerifySha = await hashFile(packVerifyPath);
    packVerifyRefs[cycleId] = {
      kind: "pack_verify",
      cycle_id: cycleId,
      path: path.relative(root, packVerifyPath).replace(/\\/g, "/"),
      sha256: packVerifySha,
      ok: packVerifyResult.ok,
    };
  }

  const recordBase = {
    hypothesis: "report test",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    negative_report: {
      type: "cost",
      summary: "cost",
      evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    },
    seeding_result: {
      outcome: "no_seed",
      summary: "no seed",
      evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    },
    selection_evidence: {
      mode: "random",
      due: false,
      cycle_id: "CY-0001",
      cycle_index: 1,
      cadence: 5,
      scope: "block",
      seed: { source: "blockId", value: "block-0005", block_id: "block-0005" },
      candidates: { total: 1, eligible: 1 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 0,
        deps: 0,
        missing_evidence: 0,
      },
      selection: { queue_id: "BL-0001", hash: crypto.createHash("sha256").update("x").digest("hex") },
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      obligations_hash: crypto.createHash("sha256").update("gate").digest("hex"),
      artifacts: [{ path: ".ato/runs/artifacts/global/gate/test.log", sha256: artifactSha }],
    },
    preflight_evidence: {
      path: ".ato/cycles/CY-0001/preflight.json",
      sha256: preflightSha,
    },
    checks: [],
  };

  const makeRecord = ({ id, ts, cycleIndex, outcome, controlGroup }) => ({
    ...recordBase,
    id,
    ts,
    cycle_index: cycleIndex,
    outcome,
    pack_ref: packRefs[id],
    pack_verify_ref: packVerifyRefs[id],
    ...(controlGroup ? { control_group: true, control_group_reason: "cadence" } : {}),
    selection_evidence: {
      ...recordBase.selection_evidence,
      cycle_id: id,
      cycle_index: cycleIndex,
    },
  });

  const records = [
    makeRecord({
      id: "CY-0001",
      ts: "2025-01-01T00:00:00.000Z",
      cycleIndex: 1,
      outcome: "ok",
      controlGroup: true,
    }),
    makeRecord({
      id: "CY-0002",
      ts: "2025-01-01T00:05:00.000Z",
      cycleIndex: 2,
      outcome: "fail",
      controlGroup: false,
    }),
  ];
  await writeJsonl(path.join(root, ".ato", "eval", "ledger.jsonl"), records);

  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "block", "report", "--block-id", "block-0005", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.cycles_planned, 3);
  assert.equal(report.cycles_recorded, 2);
  assert.equal(report.cycles_done, 1);
  assert.equal(report.cycles_fail, 1);
  assert.equal(report.cycles_with_pack_total, 2);
  assert.equal(report.cycles_with_pack_verified_total, 2);
  assert.equal(report.cycles_pack_verify_failed_total, 0);
  assert.equal(report.missing_packs.length, 0);
  assert.equal(report.pack_verify_failures.length, 0);
  assert.equal(report.control_group_cycles_total, 1);
  assert.equal(report.closeout_integrity.mode, "open_block");
  assert.equal(report.closeout_integrity.closure_present, false);
  assert.equal(report.closeout_integrity.report_present, null);
  assert.deepEqual(report.closeout_integrity.errors, []);
  assert.equal(report.consistency.ok, true);
  assert.deepEqual(report.consistency.warnings, []);
});

test("block report treats over-plan cycles as warning and is deterministic", async () => {
  const { root } = await setupReportFixture({
    cyclesPlanned: 1,
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: true,
      },
      {
        id: "CY-0002",
        ts: "2025-01-01T00:05:00.000Z",
        cycleIndex: 2,
        outcome: "fail",
        controlGroup: false,
      },
    ],
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const args = [cliPath, "block", "report", "--block-id", "block-0005", "--json"];
  const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);

  const report = JSON.parse(first.stdout.trim());
  assert.equal(report.cycles_planned, 1);
  assert.equal(report.cycles_recorded, 2);
  assert.equal(report.closeout_integrity.mode, "open_block");
  assert.deepEqual(report.closeout_integrity.errors, []);
  assert.equal(report.consistency.ok, true);
  assert.deepEqual(report.consistency.errors, []);
  assert.deepEqual(report.consistency.warnings, [
    "Recorded cycles exceed cyclesPlanned.",
  ]);
});

test("block report marks missing cyclesPlanned as consistency error", async () => {
  const { root } = await setupReportFixture({
    includeCyclesPlanned: false,
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: false,
      },
    ],
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "block", "report", "--block-id", "block-0005", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 3, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.closeout_integrity.mode, "open_block");
  assert.deepEqual(report.closeout_integrity.errors, []);
  assert.equal(report.consistency.ok, false);
  assert.deepEqual(report.consistency.warnings, []);
  assert.deepEqual(report.consistency.errors, [
    "cyclesPlanned missing from block config.",
  ]);
});

test("block close produces deterministic closure payload", async () => {
  const recordSpecs = [
    {
      id: "CY-0001",
      ts: "2025-01-01T00:00:00.000Z",
      cycleIndex: 1,
      outcome: "ok",
      controlGroup: false,
    },
    {
      id: "CY-0002",
      ts: "2025-01-01T00:05:00.000Z",
      cycleIndex: 2,
      outcome: "ok",
      controlGroup: false,
    },
  ];

  const { root } = await setupReportFixture({ recordSpecs });

  try {
    await writeBlockSeal(root);
    const firstRun = runBlockClose(root);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const secondRun = runBlockClose(root);
    assert.equal(secondRun.status, 0, secondRun.stderr);

    const closurePath = path.join(
      root,
      ".ato",
      "meta",
      "blocks",
      "block-0005.closure.json",
    );
    const closureA = await fs.readFile(closurePath, "utf8");
    const closureB = await fs.readFile(closurePath, "utf8");
    assert.equal(closureA, closureB);

    const closure = JSON.parse(closureA);
    assert.equal(closure.closed_at, "2025-01-01T00:05:00.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("block report fails on closure report_ref sha mismatch", async () => {
  const { root } = await setupReportFixture({
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: false,
      },
    ],
  });

  try {
    const reportPath = path.join(root, ".ato", "closeout", "block-0005.report.json");
    await writeJson(reportPath, { schema_version: "block-report.v1", block_id: "block-0005" });
    await writeBlockSeal(root);
    await writeBlockClosure({
      root,
      reportPath: ".ato/closeout/block-0005.report.json",
      reportSha: "sha256:wrong",
    });

    const cliPath = path.resolve("dist/cli/main.js");
    const first = spawnSync(
      process.execPath,
      [cliPath, "block", "report", "--block-id", "block-0005", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(first.status, 3, first.stderr);
    const second = spawnSync(
      process.execPath,
      [cliPath, "block", "report", "--block-id", "block-0005", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(second.status, 3, second.stderr);
    assert.equal(first.stdout, second.stdout);
    const report = JSON.parse(first.stdout.trim());
    assert.equal(report.closeout_integrity.mode, "closed_block");
    assert.equal(report.closeout_integrity.closure_present, true);
    assert.equal(report.closeout_integrity.seal_present, true);
    assert.equal(report.closeout_integrity.report_present, true);
    assert.equal(report.consistency.ok, false);
    assert.equal(
      report.closeout_integrity.errors[0].includes(
        "closure.report_ref sha256 mismatch",
      ),
      true,
    );
    assert.equal(
      report.consistency.errors.some((entry) =>
        entry.includes("closure.report_ref sha256 mismatch"),
      ),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("block report passes closeout integrity when closure and report_ref match", async () => {
  const { root } = await setupReportFixture({
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: false,
      },
    ],
  });

  try {
    const reportPath = path.join(root, ".ato", "closeout", "block-0005.report.json");
    await writeJson(reportPath, { schema_version: "block-report.v1", block_id: "block-0005" });
    const reportSha = await hashFile(reportPath);
    await writeBlockSeal(root);
    await writeBlockClosure({
      root,
      reportPath: ".ato/closeout/block-0005.report.json",
      reportSha,
    });

    const cliPath = path.resolve("dist/cli/main.js");
    const result = spawnSync(
      process.execPath,
      [cliPath, "block", "report", "--block-id", "block-0005", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.closeout_integrity.mode, "closed_block");
    assert.equal(report.closeout_integrity.closure_present, true);
    assert.equal(report.closeout_integrity.seal_present, true);
    assert.equal(report.closeout_integrity.report_present, true);
    assert.deepEqual(report.closeout_integrity.errors, []);
    assert.equal(report.consistency.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("block close succeeds over plan and preserves warning", async () => {
  const { root } = await setupReportFixture({
    cyclesPlanned: 1,
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: false,
      },
      {
        id: "CY-0002",
        ts: "2025-01-01T00:05:00.000Z",
        cycleIndex: 2,
        outcome: "ok",
        controlGroup: false,
      },
    ],
  });

  try {
    const result = runBlockClose(root);
    assert.equal(result.status, 0, result.stderr);

    const reportPath = path.join(
      root,
      ".ato",
      "closeout",
      "block-0005.report.json",
    );
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.consistency.ok, true);
    assert.deepEqual(report.consistency.warnings, [
      "Recorded cycles exceed cyclesPlanned.",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("block close refuses when report is not ok", async () => {
  const { root } = await setupReportFixture({
    includeCyclesPlanned: false,
    recordSpecs: [
      {
        id: "CY-0001",
        ts: "2025-01-01T00:00:00.000Z",
        cycleIndex: 1,
        outcome: "ok",
        controlGroup: false,
      },
    ],
  });

  try {
    const result = runBlockClose(root);
    assert.equal(result.status, 3, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.deepEqual(payload.errors, ["cyclesPlanned missing from block config."]);

    const closurePath = path.join(
      root,
      ".ato",
      "meta",
      "blocks",
      "block-0005.closure.json",
    );
    await assert.rejects(fs.access(closurePath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
