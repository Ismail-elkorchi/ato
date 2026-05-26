import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEvalCycle } from "../dist/core/eval/ledger.js";
import {
  buildCycleEvidencePack,
  verifyCycleEvidencePack,
} from "../dist/core/cycle/pack.js";

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

const toPosix = (value) => value.split(path.sep).join("/");

test("q-done evidence requires cycle finish acceptance check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-qdone-"));
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
  const artifactSha = await hashFile(artifactPath);
  const { pack_ref: packRef } = await buildCycleEvidencePack({
    root,
    store: path.join(root, storeDir),
    cycleId: "CY-0002",
    entries: [preflightPath, artifactPath],
  });
  const packVerifyResult = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
    requiredEntries: [],
  });
  const packVerifyPath = path.join(
    root,
    storeDir,
    "cycles",
    "CY-0002",
    "pack-verify.json",
  );
  await writeJson(packVerifyPath, packVerifyResult);
  const packVerifySha = await hashFile(packVerifyPath);

  const record = {
    id: "CY-0002",
    ts: "2025-01-01T00:01:00.000Z",
    cycle_index: 2,
    hypothesis: "cycle finish required",
    acceptance_checks: ["cmd:echo ok"],
    evidence: [
      `file:${toPosix(path.join(storeDir, "cycles", "CY-0002", "q-done.json"))}`,
    ],
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
      mode: "queue",
      cycle_id: "CY-0002",
      cycle_index: 2,
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
      result: { ok: true },
      obligations_hash: crypto.createHash("sha256").update("gate").digest("hex"),
      artifacts: [
        {
          path: toPosix(path.relative(root, artifactPath)),
          sha256: artifactSha,
        },
      ],
    },
    preflight_evidence: {
      path: toPosix(path.relative(root, preflightPath)),
      sha256: preflightSha,
    },
    pack_ref: packRef,
    pack_verify_ref: {
      kind: "pack_verify",
      cycle_id: "CY-0002",
      path: toPosix(path.relative(root, packVerifyPath)),
      sha256: packVerifySha,
      ok: packVerifyResult.ok,
    },
    checks: [],
  };

  const result = await validateEvalCycle({
    record,
    root,
    store: path.join(root, storeDir),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((entry) =>
      entry.includes("acceptance_checks must include cycle finish"),
    ),
  );
});
