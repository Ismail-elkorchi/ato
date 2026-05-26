import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { createAjv } from "../schemas/ajv.js";
import { readJson } from "../fs.js";

import { readCycleRecords } from "../cycle/store.js";
import { loadBlockConfig, resolveBlockId, resolveCyclesPlanned } from "./config.js";
import type { CycleRecord } from "../types.js";

const SCHEMA_URL = new URL("../schemas/block-report.v1.json", import.meta.url);

export type BlockReport = {
  schema_version: "block-report.v1";
  block_id: string;
  cycles_planned: number;
  cycles_attempted: number;
  cycles_recorded: number;
  cycles_done: number;
  cycles_inconclusive: number;
  cycles_fail: number;
  cycles_unknown: number;
  cycles_with_full_gate_artifacts: number;
  cycles_with_pack_total: number;
  cycles_with_pack_verified_total: number;
  cycles_pack_verify_failed_total: number;
  overrides_total: number;
  missing_artifacts: Array<{ cycle_id: string; path: string; reason: string }>;
  missing_packs: Array<{ cycle_id: string; path: string; reason: string }>;
  pack_verify_failures: Array<{ cycle_id: string; reason: string }>;
  closeout_integrity: {
    policy_version: "block-closeout-integrity.v1";
    mode: "open_block" | "closed_block";
    closure_path: string;
    seal_path: string;
    canonical_report_path: string;
    closure_present: boolean;
    seal_present: boolean;
    report_present: boolean | null;
    report_ref_path: string | null;
    report_ref_sha256: string | null;
    errors: string[];
    warnings: string[];
  };
  consistency?: { ok: boolean; errors: string[]; warnings: string[] };
};

const loadReportSchema = async (): Promise<unknown> => {
  const raw = await fs.readFile(SCHEMA_URL, "utf8");
  return JSON.parse(raw);
};

const splitPathSuffix = (value: string): { path: string; suffix: string } => {
  const match = value.match(/^(.*?)(:\d+(?::\d+)?)$/);
  if (!match) return { path: value, suffix: "" };
  return { path: match[1] ?? value, suffix: match[2] ?? "" };
};

const extractEvidencePath = (entry: string): string | null => {
  const trimmed = String(entry ?? "").trim();
  if (!trimmed || trimmed.startsWith("cmd:")) return null;
  const prefixMatch = trimmed.match(/^(file|output):(.+)$/);
  const candidate = prefixMatch && prefixMatch[2] ? prefixMatch[2] : trimmed;
  const { path: rawPath } = splitPathSuffix(candidate.trim());
  return rawPath ? rawPath : null;
};

const hashFile = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const toRelativePath = (root: string, filePath: string): string =>
  path.relative(root, filePath).replace(/\\/g, "/");

const resolveCloseoutIntegrity = async ({
  root,
  store,
  blockId,
}: {
  root: string;
  store: string;
  blockId: string;
}): Promise<{
  integrity: BlockReport["closeout_integrity"];
  missing_artifacts: BlockReport["missing_artifacts"];
}> => {
  const closurePath = path.join(store, "meta", "blocks", `${blockId}.closure.json`);
  const sealPath = path.join(store, "meta", "blocks", `${blockId}.seal.json`);
  const canonicalReportPath = path.join(store, "closeout", `${blockId}.report.json`);
  const closureRelative = toRelativePath(root, closurePath);
  const sealRelative = toRelativePath(root, sealPath);
  const canonicalReportRelative = toRelativePath(root, canonicalReportPath);
  const closureExists = await fs
    .access(closurePath)
    .then(() => true)
    .catch(() => false);
  const sealExists = await fs
    .access(sealPath)
    .then(() => true)
    .catch(() => false);

  const integrity: BlockReport["closeout_integrity"] = {
    policy_version: "block-closeout-integrity.v1",
    mode: closureExists ? "closed_block" : "open_block",
    closure_path: closureRelative,
    seal_path: sealRelative,
    canonical_report_path: canonicalReportRelative,
    closure_present: closureExists,
    seal_present: sealExists,
    report_present: null,
    report_ref_path: null,
    report_ref_sha256: null,
    errors: [],
    warnings: [],
  };
  const missingArtifacts: BlockReport["missing_artifacts"] = [];

  if (!closureExists) {
    return { integrity, missing_artifacts: missingArtifacts };
  }

  if (!sealExists) {
    integrity.errors.push("closeout integrity: block seal artifact is missing.");
    missingArtifacts.push({
      cycle_id: blockId,
      path: sealRelative,
      reason: "missing_block_seal",
    });
  }

  const closureRaw = await readJson<Record<string, unknown> | null>(closurePath, null);
  const reportRefRaw =
    closureRaw &&
    typeof closureRaw["report_ref"] === "object" &&
    closureRaw["report_ref"] !== null &&
    !Array.isArray(closureRaw["report_ref"])
      ? (closureRaw["report_ref"] as Record<string, unknown>)
      : null;
  const reportRefPath =
    reportRefRaw && typeof reportRefRaw["path"] === "string"
      ? reportRefRaw["path"].trim()
      : "";
  const reportRefSha =
    reportRefRaw && typeof reportRefRaw["sha256"] === "string"
      ? reportRefRaw["sha256"].trim()
      : "";
  integrity.report_ref_path = reportRefPath || null;
  integrity.report_ref_sha256 = reportRefSha || null;

  if (!reportRefPath || !reportRefSha) {
    integrity.errors.push("closeout integrity: closure.report_ref requires path and sha256.");
    missingArtifacts.push({
      cycle_id: blockId,
      path: closureRelative,
      reason: "invalid_report_ref",
    });
    integrity.errors.sort();
    integrity.warnings.sort();
    return { integrity, missing_artifacts: missingArtifacts };
  }

  if (path.isAbsolute(reportRefPath)) {
    integrity.errors.push("closeout integrity: closure.report_ref.path must be repo-relative.");
    missingArtifacts.push({
      cycle_id: blockId,
      path: reportRefPath,
      reason: "absolute_report_ref_path",
    });
  }
  if (reportRefPath !== canonicalReportRelative) {
    integrity.errors.push(
      `closeout integrity: closure.report_ref.path mismatch (expected ${canonicalReportRelative}, got ${reportRefPath}).`,
    );
    missingArtifacts.push({
      cycle_id: blockId,
      path: reportRefPath,
      reason: "report_ref_path_mismatch",
    });
  }

  const reportPath = path.resolve(root, reportRefPath);
  const reportExists = await fs
    .access(reportPath)
    .then(() => true)
    .catch(() => false);
  integrity.report_present = reportExists;
  if (!reportExists) {
    integrity.errors.push("closeout integrity: referenced closeout report artifact is missing.");
    missingArtifacts.push({
      cycle_id: blockId,
      path: reportRefPath,
      reason: "missing_report_artifact",
    });
    integrity.errors.sort();
    integrity.warnings.sort();
    return { integrity, missing_artifacts: missingArtifacts };
  }

  const actualReportSha = await hashFile(reportPath);
  if (actualReportSha !== reportRefSha) {
    integrity.errors.push(
      `closeout integrity: closure.report_ref sha256 mismatch (expected ${reportRefSha}, got ${actualReportSha}).`,
    );
    missingArtifacts.push({
      cycle_id: blockId,
      path: reportRefPath,
      reason: "report_ref_sha256_mismatch",
    });
  }

  integrity.errors.sort();
  integrity.warnings.sort();
  return { integrity, missing_artifacts: missingArtifacts };
};

const blockMatches = (record: CycleRecord, blockId: string): boolean =>
  record.block_id === blockId;

const reportConsistency = ({
  report,
  cyclesPlanned,
}: {
  report: BlockReport;
  cyclesPlanned: number | null;
}): { ok: boolean; errors: string[]; warnings: string[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const totals =
    report.cycles_done +
    report.cycles_inconclusive +
    report.cycles_fail +
    report.cycles_unknown;
  if (totals !== report.cycles_recorded) {
    errors.push("Recorded cycles do not sum to outcome buckets.");
  }
  if (cyclesPlanned === null) {
    errors.push("cyclesPlanned missing from block config.");
  } else if (report.cycles_recorded > cyclesPlanned) {
    warnings.push("Recorded cycles exceed cyclesPlanned.");
  }
  if (report.cycles_with_full_gate_artifacts > report.cycles_recorded) {
    errors.push("cycles_with_full_gate_artifacts exceeds cycles_recorded.");
  }
  if (report.cycles_with_pack_total > report.cycles_recorded) {
    errors.push("cycles_with_pack_total exceeds cycles_recorded.");
  }
  if (report.cycles_with_pack_verified_total > report.cycles_recorded) {
    errors.push("cycles_with_pack_verified_total exceeds cycles_recorded.");
  }
  if (report.cycles_pack_verify_failed_total > report.cycles_recorded) {
    errors.push("cycles_pack_verify_failed_total exceeds cycles_recorded.");
  }
  errors.sort();
  warnings.sort();
  return { ok: errors.length === 0, errors, warnings };
};

export const buildBlockReport = async ({
  root,
  store,
  blockId,
}: {
  root: string;
  store: string;
  blockId: string;
}): Promise<{ report: BlockReport; ok: boolean; errors: string[] }> => {
  const block = await loadBlockConfig(store, blockId);
  const resolvedId = resolveBlockId(block);
  if (!block || resolvedId !== blockId) {
    throw new Error(`Unknown block_id '${blockId}'.`);
  }
  const cyclesPlanned = resolveCyclesPlanned(block);
  const plannedValue = cyclesPlanned ?? 0;

  const records = await readCycleRecords(store);
  const blockRecords = records.filter((record) => blockMatches(record, blockId));

  const missingArtifacts: BlockReport["missing_artifacts"] = [];
  const missingKeys = new Set<string>();
  const missingPacks: BlockReport["missing_packs"] = [];
  const missingPackKeys = new Set<string>();
  const packVerifyFailures: BlockReport["pack_verify_failures"] = [];
  const packVerifyFailureKeys = new Set<string>();
  let packsTotal = 0;
  let packsVerifiedTotal = 0;
  let packsVerifyFailedTotal = 0;

  for (const record of blockRecords) {
    const cycleId = record.id;
    const gateArtifacts = record.gate_evidence?.artifacts ?? [];
    for (const artifact of gateArtifacts) {
      const rawPath = String(artifact.path ?? "").trim();
      const sha = String(artifact.sha256 ?? "").trim();
      if (!rawPath || !sha) continue;
      const resolved = path.resolve(root, rawPath);
      try {
        const actual = await hashFile(resolved);
        if (actual !== sha) {
          const key = `${cycleId}:${rawPath}:sha256_mismatch`;
          if (!missingKeys.has(key)) {
            missingKeys.add(key);
            missingArtifacts.push({
              cycle_id: cycleId,
              path: rawPath,
              reason: `sha256_mismatch expected ${sha} got ${actual}`,
            });
          }
        }
      } catch {
        const key = `${cycleId}:${rawPath}:missing`;
        if (!missingKeys.has(key)) {
          missingKeys.add(key);
          missingArtifacts.push({
            cycle_id: cycleId,
            path: rawPath,
            reason: "missing",
          });
        }
      }
    }

    const preflightPath = record.preflight_evidence?.path;
    if (preflightPath) {
      const resolved = path.resolve(root, preflightPath);
      try {
        await fs.access(resolved);
      } catch {
        const key = `${cycleId}:${preflightPath}:missing`;
        if (!missingKeys.has(key)) {
          missingKeys.add(key);
          missingArtifacts.push({
            cycle_id: cycleId,
            path: preflightPath,
            reason: "missing",
          });
        }
      }
    }

    const evidenceEntries = record.evidence ?? [];
    for (const entry of evidenceEntries) {
      const rawPath = extractEvidencePath(entry);
      if (!rawPath) continue;
      const resolved = path.resolve(root, rawPath);
      try {
        await fs.access(resolved);
      } catch {
        const key = `${cycleId}:${rawPath}:missing`;
        if (!missingKeys.has(key)) {
          missingKeys.add(key);
          missingArtifacts.push({
            cycle_id: cycleId,
            path: rawPath,
            reason: "missing",
          });
        }
      }
    }

    const packRef = record.pack_ref;
    const packPath = packRef ? String(packRef.path ?? "").trim() : "";
    const packSha = packRef ? String(packRef.sha256 ?? "").trim() : "";
    const manifestPath = packRef ? String(packRef.manifest_path ?? "").trim() : "";
    if (packPath) packsTotal += 1;
    if (!packRef || !packPath || !packSha) {
      const key = `${cycleId}:pack_ref:missing`;
      if (!missingPackKeys.has(key)) {
        missingPackKeys.add(key);
        missingPacks.push({
          cycle_id: cycleId,
          path: packPath || "<missing_pack_ref>",
          reason: "missing_pack_ref",
        });
      }
    } else {
      const resolved = path.resolve(root, packPath);
      try {
        const actual = await hashFile(resolved);
        if (actual !== packSha) {
          const key = `${cycleId}:${packPath}:sha256_mismatch`;
          if (!missingPackKeys.has(key)) {
            missingPackKeys.add(key);
            missingPacks.push({
              cycle_id: cycleId,
              path: packPath,
              reason: `sha256_mismatch expected ${packSha} got ${actual}`,
            });
          }
        }
      } catch {
        const key = `${cycleId}:${packPath}:missing`;
        if (!missingPackKeys.has(key)) {
          missingPackKeys.add(key);
          missingPacks.push({
            cycle_id: cycleId,
            path: packPath,
            reason: "missing",
          });
        }
      }
    }

    if (manifestPath) {
      const resolved = path.resolve(root, manifestPath);
      try {
        await fs.access(resolved);
      } catch {
        const key = `${cycleId}:${manifestPath}:missing`;
        if (!missingPackKeys.has(key)) {
          missingPackKeys.add(key);
          missingPacks.push({
            cycle_id: cycleId,
            path: manifestPath,
            reason: "missing_manifest",
          });
        }
      }
    }

    const packVerifyRef = record.pack_verify_ref;
    const verifyPath = packVerifyRef ? String(packVerifyRef.path ?? "").trim() : "";
    const verifySha = packVerifyRef ? String(packVerifyRef.sha256 ?? "").trim() : "";
    if (!packVerifyRef || !verifyPath || !verifySha) {
      const key = `${cycleId}:pack_verify_ref:missing`;
      if (!packVerifyFailureKeys.has(key)) {
        packVerifyFailureKeys.add(key);
        packVerifyFailures.push({
          cycle_id: cycleId,
          reason: "missing_pack_verify_ref",
        });
      }
      packsVerifyFailedTotal += 1;
    } else {
      const resolved = path.resolve(root, verifyPath);
      try {
        const actual = await hashFile(resolved);
        if (actual !== verifySha) {
          const key = `${cycleId}:${verifyPath}:sha256_mismatch`;
          if (!packVerifyFailureKeys.has(key)) {
            packVerifyFailureKeys.add(key);
            packVerifyFailures.push({
              cycle_id: cycleId,
              reason: `sha256_mismatch expected ${verifySha} got ${actual}`,
            });
          }
          packsVerifyFailedTotal += 1;
        } else if (!packVerifyRef.ok) {
          const key = `${cycleId}:${verifyPath}:verify_failed`;
          if (!packVerifyFailureKeys.has(key)) {
            packVerifyFailureKeys.add(key);
            packVerifyFailures.push({
              cycle_id: cycleId,
              reason: "verify_failed",
            });
          }
          packsVerifyFailedTotal += 1;
        } else {
          packsVerifiedTotal += 1;
        }
      } catch {
        const key = `${cycleId}:${verifyPath}:missing`;
        if (!packVerifyFailureKeys.has(key)) {
          packVerifyFailureKeys.add(key);
          packVerifyFailures.push({
            cycle_id: cycleId,
            reason: "missing_pack_verify_file",
          });
        }
        packsVerifyFailedTotal += 1;
      }
    }
  }

  const closeoutIntegrity = await resolveCloseoutIntegrity({
    root,
    store,
    blockId,
  });
  for (const entry of closeoutIntegrity.missing_artifacts) {
    const key = `${entry.cycle_id}:${entry.path}:${entry.reason}`;
    if (missingKeys.has(key)) continue;
    missingKeys.add(key);
    missingArtifacts.push(entry);
  }

  const report: BlockReport = {
    schema_version: "block-report.v1",
    block_id: blockId,
    cycles_planned: plannedValue,
    cycles_attempted: blockRecords.length,
    cycles_recorded: blockRecords.length,
    cycles_done: blockRecords.filter((record) => record.outcome === "ok").length,
    cycles_inconclusive: blockRecords.filter((record) => record.outcome === "inconclusive")
      .length,
    cycles_fail: blockRecords.filter((record) => record.outcome === "fail").length,
    cycles_unknown: blockRecords.filter((record) => record.outcome === "unknown").length,
    cycles_with_full_gate_artifacts: blockRecords.filter(
      (record) => (record.gate_evidence?.artifacts ?? []).length > 0,
    ).length,
    cycles_with_pack_total: packsTotal,
    cycles_with_pack_verified_total: packsVerifiedTotal,
    cycles_pack_verify_failed_total: packsVerifyFailedTotal,
    overrides_total: 0,
    missing_artifacts: missingArtifacts,
    missing_packs: missingPacks,
    pack_verify_failures: packVerifyFailures,
    closeout_integrity: closeoutIntegrity.integrity,
  };

  const consistency = reportConsistency({ report, cyclesPlanned });
  consistency.errors.push(...closeoutIntegrity.integrity.errors);
  consistency.warnings.push(...closeoutIntegrity.integrity.warnings);
  consistency.errors = [...new Set(consistency.errors)].sort();
  consistency.warnings = [...new Set(consistency.warnings)].sort();
  consistency.ok = consistency.errors.length === 0;
  report.consistency = consistency;

  const schema = await loadReportSchema();
  const ajv = createAjv();
  const validate = ajv.compile(schema);
  const schemaOk = validate(report);
  const errors: string[] = [];
  if (!schemaOk) {
    for (const error of validate.errors ?? []) {
      errors.push(`${error.instancePath} ${error.message}`);
    }
  }
  if (!consistency.ok) {
    errors.push(...consistency.errors);
  }

  return { report, ok: errors.length === 0, errors };
};
