import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  assembleGateShardPayloads,
  mergeGateShardResults,
  deriveNonTestStatus,
  resolveNonTestStatus,
  normalizeShardResultId,
  parseGateShardSpec,
  selectShardBatch,
  listPendingShards,
  computeShardBudget,
  rewriteDeterminismGateForShard,
  rewriteTestGateForShard,
  shouldRunGateForShard,
} from "../dist/cli/commands/gate-shard.js";
import { nodeAdapter } from "../dist/core/adapters/node.js";
import { spawnSync } from "node:child_process";

test("parseGateShardSpec validates K/N", () => {
  assert.deepEqual(parseGateShardSpec("1/4"), { index: 1, count: 4 });
  assert.deepEqual(parseGateShardSpec(" 2 / 3 "), { index: 2, count: 3 });
  assert.equal(parseGateShardSpec(undefined), null);
  assert.throws(() => parseGateShardSpec("0/2"));
  assert.throws(() => parseGateShardSpec("2/1"));
  assert.throws(() => parseGateShardSpec("nope"));
});

test("shouldRunGateForShard only runs test gates when sharded", () => {
  const shard = { index: 2, count: 3 };
  const testGate = { id: "test", cmd: ["npm", "run", "test"] };
  const lintGate = { id: "lint", cmd: ["npm", "run", "lint"] };
  assert.equal(shouldRunGateForShard(testGate, shard), true);
  assert.equal(shouldRunGateForShard(lintGate, shard), false);
  assert.equal(shouldRunGateForShard(lintGate, { index: 1, count: 3 }), false);
  assert.equal(
    shouldRunGateForShard(lintGate, { index: 1, count: 3 }, { nonTestOnly: true }),
    true,
  );
});

test("assembleGateShardPayloads merges shards deterministically", () => {
  const baseResult = (id, command) => ({
    id,
    command,
    ok: true,
    exitCode: 0,
    durationMs: 1,
    started_at: "2026-01-30T00:00:00.000Z",
    ended_at: "2026-01-30T00:00:01.000Z",
    status: "ok",
    touched_files: [],
    artifact: null,
    triage: null,
  });

  const shard1 = {
    schema_version: "gate-shard.v1",
    shard: { index: 1, count: 2 },
    gate: {
      ok: true,
      mode: "full",
      results: [
        baseResult("lint", "npm run lint"),
        baseResult("test#1-of-2", "npm run test"),
      ],
      total_duration_ms: 5,
      plan: { mode: "full-all" },
      preflight: null,
      overrides: null,
      artifacts: [".ato/a.json"],
    },
  };

  const shard2 = {
    schema_version: "gate-shard.v1",
    shard: { index: 2, count: 2 },
    gate: {
      ok: true,
      mode: "full",
      results: [
        baseResult("lint", "npm run lint"),
        baseResult("test#2-of-2", "npm run test"),
      ],
      total_duration_ms: 7,
      plan: { mode: "full-all" },
      preflight: null,
      overrides: null,
      artifacts: [".ato/b.json"],
    },
  };

  const assembled = assembleGateShardPayloads([shard2, shard1]);
  assert.equal(assembled.ok, true);
  assert.deepEqual(
    assembled.results.map((r) => r.id),
    ["lint", "test#1-of-2", "test#2-of-2"],
  );
  assert.deepEqual(assembled.artifacts, [".ato/a.json", ".ato/b.json"]);
  assert.equal(assembled.total_duration_ms, 12);
});

test("assembleGateShardPayloads includes non-test shard payloads", () => {
  const baseResult = (id, command) => ({
    id,
    command,
    ok: true,
    exitCode: 0,
    durationMs: 1,
    started_at: "2026-01-30T00:00:00.000Z",
    ended_at: "2026-01-30T00:00:01.000Z",
    status: "ok",
    touched_files: [],
    artifact: null,
    triage: null,
  });

  const nonTest = {
    schema_version: "gate-shard.v1",
    shard: { index: 0, count: 2 },
    gate: {
      ok: true,
      mode: "full",
      results: [baseResult("determinism", "node scripts/check-determinism.mjs")],
      total_duration_ms: 2,
      plan: { mode: "full-all" },
      preflight: null,
      overrides: null,
      artifacts: [".ato/d.json"],
    },
  };

  const shard1 = {
    schema_version: "gate-shard.v1",
    shard: { index: 1, count: 2 },
    gate: {
      ok: true,
      mode: "full",
      results: [baseResult("test#1-of-2", "npm run test")],
      total_duration_ms: 5,
      plan: { mode: "full-all" },
      preflight: null,
      overrides: null,
      artifacts: [".ato/a.json"],
    },
  };

  const shard2 = {
    schema_version: "gate-shard.v1",
    shard: { index: 2, count: 2 },
    gate: {
      ok: true,
      mode: "full",
      results: [baseResult("test#2-of-2", "npm run test")],
      total_duration_ms: 7,
      plan: { mode: "full-all" },
      preflight: null,
      overrides: null,
      artifacts: [".ato/b.json"],
    },
  };

  const assembled = assembleGateShardPayloads([shard2, nonTest, shard1]);
  assert.equal(assembled.ok, true);
  assert.deepEqual(
    assembled.results.map((r) => r.id),
    ["determinism", "test#1-of-2", "test#2-of-2"],
  );
  assert.deepEqual(assembled.artifacts, [".ato/a.json", ".ato/b.json", ".ato/d.json"]);
  assert.equal(assembled.total_duration_ms, 14);
});

test("node adapter enforces timeout even if SIGTERM is ignored", async () => {
  const result = await nodeAdapter.executeStep({
    cmd: [
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
    ],
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.ok, false);
  assert.ok(result.durationMs < 2000);
});

test("gate run budget=0 exits 0 with budget_exhausted and resume guidance", () => {
  const statePath = path.join(process.cwd(), ".ato", "state.json");
  const resolveShardDir = () => {
    let shardDir = path.join(process.cwd(), ".ato", "gates");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state && typeof state.activeCycleId === "string") {
        shardDir = path.join(process.cwd(), ".ato", "cycles", state.activeCycleId);
      }
    }
    return shardDir;
  };
  const shardDirBefore = resolveShardDir();
  const progressPathBefore = path.join(shardDirBefore, "gate-progress.json");
  const progressBefore = fs.existsSync(progressPathBefore)
    ? JSON.parse(fs.readFileSync(progressPathBefore, "utf8"))
    : null;
  const completedBefore = Array.isArray(progressBefore?.completed)
    ? [...progressBefore.completed].sort((a, b) => a - b)
    : null;
  const shardOutputsBefore = Array.isArray(progressBefore?.shard_outputs)
    ? [...progressBefore.shard_outputs]
    : null;
  const res = spawnSync(
    process.execPath,
    [
      "dist/cli/main.js",
      "gate",
      "run",
      "--mode",
      "full",
      "--json",
      "--shard",
      "1/256",
      "--shard-batch",
      "5",
      "--shard-budget-ms",
      "0",
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.shard_batch?.budget_exhausted, true);
  const resume = String(parsed.shard_batch?.resume_command ?? "");
  assert.ok(resume.length > 0);
  assert.ok(!resume.includes("--shard-budget-ms 0"));
  const shardDir = resolveShardDir();
  const progressPath = path.join(shardDir, "gate-progress.json");
  assert.ok(fs.existsSync(progressPath), `missing progress file at ${progressPath}`);
  const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
  const shardCount =
    progress && progress.shard && typeof progress.shard.count === "number"
      ? progress.shard.count
      : 256;
  const shardFiles = fs
    .readdirSync(shardDir)
    .filter((entry) => /^gate-full\\.shard-\\d+-of-256\\.json$/.test(entry));
  const indices = shardFiles
    .map((entry) => {
      const match = entry.match(/shard-(\\d+)-of-256\\.json$/);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value))
    .sort((a, b) => a - b);
  const relPath = (value) =>
    path.relative(process.cwd(), value).split(path.sep).join(path.posix.sep);
  const expectedOutputs = indices.map((index) =>
    relPath(path.join(shardDir, `gate-full.shard-${index}-of-256.json`)),
  );
  const completed = Array.isArray(progress.completed) ? progress.completed : [];
  const completedSorted = [...completed].sort((a, b) => a - b);
  const diskCompleted = indices.filter((index) => index !== 0);
  const expectedCompleted =
    diskCompleted.length > 0 ? diskCompleted : completedBefore ?? [];
  assert.deepEqual(completedSorted, expectedCompleted);
  const shardOutputs = Array.isArray(progress.shard_outputs) ? progress.shard_outputs : [];
  const expectedShardOutputs =
    expectedOutputs.length > 0 ? expectedOutputs : shardOutputsBefore ?? [];
  assert.deepEqual(shardOutputs, expectedShardOutputs);
  const pending = Array.isArray(progress.test_shard_pending)
    ? progress.test_shard_pending
    : [];
  const completedSet = new Set(completedSorted);
  const pendingInCompleted = pending.filter((index) => completedSet.has(index));
  assert.equal(pendingInCompleted.length, 0);
  assert.equal(shardCount, 256);
});

test("mergeGateShardResults merges partial non-test results deterministically", () => {
  const baseResult = (id) => ({
    id,
    command: id,
    ok: true,
    exitCode: 0,
    durationMs: 1,
    started_at: "2026-01-30T00:00:00.000Z",
    ended_at: "2026-01-30T00:00:01.000Z",
    status: "ok",
    touched_files: [],
    artifact: null,
    triage: null,
  });

  const first = {
    ok: true,
    mode: "full",
    results: [baseResult("determinism")],
    total_duration_ms: 2,
    plan: { mode: "full-all" },
    preflight: null,
    overrides: null,
    artifacts: [".ato/d.json"],
  };

  const second = {
    ok: true,
    mode: "full",
    results: [baseResult("holdout-target-resolve")],
    total_duration_ms: 3,
    plan: { mode: "full-all" },
    preflight: null,
    overrides: null,
    artifacts: [".ato/h.json"],
  };

  const merged = mergeGateShardResults([first, second], [
    "determinism",
    "holdout-target-resolve",
  ]);
  assert.equal(merged.ok, true);
  assert.deepEqual(
    merged.results.map((r) => r.id),
    ["determinism", "holdout-target-resolve"],
  );
  assert.deepEqual(merged.artifacts, [".ato/d.json", ".ato/h.json"]);
  assert.equal(merged.total_duration_ms, 5);
});

test("deriveNonTestStatus marks completion when shard-0 contains all non-test ids", () => {
  const shard0 = {
    schema_version: "gate-shard.v1",
    shard: { index: 0, count: 4 },
    gate: {
      ok: true,
      mode: "full",
      results: [
        { id: "determinism", command: "node scripts/check-determinism.mjs", ok: true, exitCode: 0, durationMs: 1, started_at: "2026-01-30T00:00:00.000Z", ended_at: "2026-01-30T00:00:01.000Z", status: "ok", touched_files: [], artifact: null, triage: null },
        { id: "holdout-target-resolve", command: "node dist/cli/main.js repo resolve", ok: true, exitCode: 0, durationMs: 1, started_at: "2026-01-30T00:00:00.000Z", ended_at: "2026-01-30T00:00:01.000Z", status: "ok", touched_files: [], artifact: null, triage: null },
        { id: "holdout-protocol-check", command: "node dist/cli/main.js protocol check", ok: true, exitCode: 0, durationMs: 1, started_at: "2026-01-30T00:00:00.000Z", ended_at: "2026-01-30T00:00:01.000Z", status: "ok", touched_files: [], artifact: null, triage: null },
      ],
      total_duration_ms: 3,
      plan: null,
      preflight: null,
      overrides: null,
      artifacts: [],
    },
  };
  const nonTestIds = ["determinism", "holdout-target-resolve", "holdout-protocol-check"];
  const { nonTestCompleted, nonTestTotal, nonTestComplete } = deriveNonTestStatus({
    shard0,
    nonTestIds,
  });
  assert.equal(nonTestTotal, 3);
  assert.equal(nonTestComplete, true);
  assert.deepEqual(nonTestCompleted, nonTestIds);
});

test("resolveNonTestStatus preserves non-test completion when shard-0 is absent", () => {
  const fallback = {
    nonTestCompleted: ["determinism", "holdout-target-resolve"],
    nonTestTotal: 2,
    nonTestComplete: true,
  };
  const { nonTestCompleted, nonTestTotal, nonTestComplete } = resolveNonTestStatus({
    shard0: null,
    nonTestIds: ["determinism", "holdout-target-resolve"],
    fallback,
  });
  assert.equal(nonTestTotal, 2);
  assert.equal(nonTestComplete, true);
  assert.deepEqual(nonTestCompleted, fallback.nonTestCompleted);
});

test("normalizeShardResultId encodes shard index for test results", () => {
  const result9 = {
    id: "test",
    command: "node scripts/parallel-runner.mjs --shard 9/256 test/*.test.js",
  };
  const result10 = {
    id: "test",
    command: "node scripts/parallel-runner.mjs --shard 10/256 test/*.test.js",
  };
  const id9 = normalizeShardResultId(result9, { index: 1, count: 256 });
  const id10 = normalizeShardResultId(result10, { index: 1, count: 256 });
  assert.equal(id9, "test#9-of-256");
  assert.equal(id10, "test#10-of-256");
});

test("selectShardBatch chooses pending shards deterministically", () => {
  const pending = listPendingShards({
    count: 5,
    completed: [2, 4],
    startIndex: 1,
  });
  assert.deepEqual(pending, [1, 3, 5]);
  const { selected } = selectShardBatch({
    count: 5,
    completed: [2, 4],
    startIndex: 1,
    batchSize: 2,
  });
  assert.deepEqual(selected, [1, 3]);
});

test("selectShardBatch respects startIndex", () => {
  const { selected, pending } = selectShardBatch({
    count: 5,
    completed: [1, 2, 4],
    startIndex: 3,
    batchSize: 3,
  });
  assert.deepEqual(pending, [3, 5]);
  assert.deepEqual(selected, [3, 5]);
});

test("rewriteTestGateForShard rewrites npm run test to parallel-runner", () => {
  const gate = { id: "test", cmd: ["npm", "run", "test"] };
  const rewritten = rewriteTestGateForShard(gate, { index: 2, count: 4 });
  assert.deepEqual(rewritten.cmd, [
    "node",
    "scripts/parallel-runner.mjs",
    "--shard",
    "2/4",
    "test/*.test.js",
    "test/holdout/*.test.js",
  ]);
});

test("rewriteDeterminismGateForShard adds --mode tsc and budget in non-test mode", () => {
  const gate = { id: "determinism", cmd: ["node", "scripts/check-determinism.mjs"] };
  const rewritten = rewriteDeterminismGateForShard(gate, {
    nonTestOnly: true,
    budgetMs: 9000,
  });
  assert.deepEqual(rewritten.cmd, [
    "node",
    "scripts/check-determinism.mjs",
    "--mode",
    "tsc",
    "--budget-ms",
    "9000",
  ]);
});

test("computeShardBudget enforces minimum start and timeout", () => {
  const tiny = computeShardBudget({ remainingMs: 1, safetyMs: 250, minStartMs: 500 });
  assert.equal(tiny.canStart, false);
  assert.equal(tiny.timeoutMs, 0);

  const adequate = computeShardBudget({ remainingMs: 1200, safetyMs: 200, minStartMs: 500 });
  assert.equal(adequate.canStart, true);
  assert.equal(adequate.timeoutMs, 1000);
});

test("computeShardBudget blocks zero budget", () => {
  const none = computeShardBudget({ remainingMs: 0, safetyMs: 200, minStartMs: 500 });
  assert.equal(none.canStart, false);
  assert.equal(none.timeoutMs, 0);
});
