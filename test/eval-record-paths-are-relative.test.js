import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeEvalCycleInput } from "../dist/core/eval/ledger.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

test("eval cycle record normalizes absolute paths to repo-relative", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-paths-"));
  const storeDir = ".ato";

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

  const packPath = path.join(root, storeDir, "packs", "CY-0002.tar");
  await fs.mkdir(path.dirname(packPath), { recursive: true });
  await fs.writeFile(packPath, "pack ok", "utf8");
  const packSha = await hashFile(packPath);
  const manifestPath = path.join(root, storeDir, "packs", "CY-0002.manifest.json");
  await writeJson(manifestPath, {
    schema_version: "cycle-pack-manifest.v1",
    cycle_id: "CY-0002",
    pack_path: path.relative(root, packPath),
    pack_sha256: packSha,
    entries: [],
  });

  const packVerifyPath = path.join(
    root,
    storeDir,
    "cycles",
    "CY-0002",
    "pack-verify.json",
  );
  await writeJson(packVerifyPath, {
    ok: true,
    schema_version: "pack-verify.v1",
    cycle_id: "CY-0002",
    pack_path: path.relative(root, packPath),
    pack_sha256: packSha,
    manifest_path: path.relative(root, manifestPath),
    verified_files_count: 0,
    required_files: [],
    missing_required: [],
    failures: [],
  });
  const packVerifySha = await hashFile(packVerifyPath);

  const record = {
    id: "CY-0002",
    ts: "2025-01-01T00:01:00.000Z",
    hypothesis: "paths normalized",
    acceptance_checks: ["cmd:echo ok"],
    evidence: [`file:${artifactPath}`],
    outcome: "ok",
    negative_report: {
      type: "cost",
      summary: "none",
      evidence: ["output:ok"],
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      artifacts: [{ path: artifactPath, sha256: artifactSha }],
    },
    preflight_evidence: { path: preflightPath, sha256: preflightSha },
    pack_ref: {
      kind: "cycle_pack",
      cycle_id: "CY-0002",
      path: packPath,
      sha256: packSha,
      manifest_path: manifestPath,
    },
    pack_verify_ref: {
      kind: "pack_verify",
      cycle_id: "CY-0002",
      path: packVerifyPath,
      sha256: packVerifySha,
      ok: true,
    },
  };

  const recorded = normalizeEvalCycleInput({
    input: record,
    fallbackId: "CY-0002",
    root,
  });
  const serialized = JSON.stringify(recorded);
  assert.equal(serialized.includes(root), false);
  assert.equal(path.isAbsolute(recorded.preflight_evidence?.path ?? ""), false);
  assert.equal(
    path.isAbsolute(recorded.gate_evidence?.artifacts?.[0]?.path ?? ""),
    false,
  );
  assert.equal(path.isAbsolute(recorded.pack_ref?.path ?? ""), false);
  assert.equal(path.isAbsolute(recorded.pack_ref?.manifest_path ?? ""), false);
  assert.equal(path.isAbsolute(recorded.pack_verify_ref?.path ?? ""), false);
});
