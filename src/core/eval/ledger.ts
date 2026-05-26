import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import {
  appendJsonl,
  ensureDir,
  fileExists,
  readJson,
  readJsonl,
  writeJson,
  writeJsonl,
} from "../fs.js";
import { isIsoDate } from "../queue/transitions.js";
import { normalizeHoldoutGateId, resolveHoldoutTasks } from "../blocks/holdout.js";
import type {
  AtoConfig,
  EvalCheckCatalogEntry,
  EvalCheckRecord,
  EvalConfig,
  EvalCycleRecord,
  EvalCycleIntegrity,
  CyclePackRef,
  PackVerifyRef,
  EvalGateArtifactEvidence,
  EvalGateEvidence,
  EvalNegativeReport,
  EvalNegativeReportType,
  EvalOutcome,
  EvalSelectionEvidence,
  EvalScorecard,
} from "../types.js";

const SCHEMA_URL = new URL("../schemas/eval-cycle.v1.json", import.meta.url);

export const evalDir = (store: string): string => path.join(store, "eval");
export const evalConfigPath = (store: string): string =>
  path.join(evalDir(store), "config.json");
export const evalLedgerPath = (store: string): string =>
  path.join(evalDir(store), "ledger.jsonl");
export const evalScorecardPath = (store: string): string =>
  path.join(evalDir(store), "scorecard.json");

const loadEvalSchema = async (): Promise<unknown> => {
  const raw = await fs.readFile(SCHEMA_URL, "utf8");
  return JSON.parse(raw);
};

const normalizeCmd = (gate: { cmd?: string[]; command?: string[] }): string[] =>
  Array.isArray(gate.cmd) && gate.cmd.length
    ? gate.cmd
    : Array.isArray(gate.command) && gate.command.length
      ? gate.command
      : [];

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(normalized)];
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const resolvePath = (root: string, value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(root, value);

const hashFile = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const normalizeRecordPath = (root: string, value: string): string => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return trimmed;
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(root, trimmed);
  const relative = path.relative(root, resolved) || ".";
  return toPosixPath(relative);
};

const splitPathSuffix = (
  value: string,
): { path: string; suffix: string } => {
  const match = value.match(/^(.*?)(:\d+(?::\d+)?)$/);
  if (!match) return { path: value, suffix: "" };
  return { path: match[1] ?? value, suffix: match[2] ?? "" };
};

const normalizeEvidenceEntry = (root: string, entry: string): string => {
  const trimmed = String(entry ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("cmd:")) return trimmed;
  const prefixMatch = trimmed.match(/^(file|output):(.+)$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    const matchPath = prefixMatch[2] ?? "";
    const { path: rawPath, suffix } = splitPathSuffix(matchPath.trim());
    const normalized = normalizeRecordPath(root, rawPath);
    return `${prefix}:${normalized}${suffix}`;
  }
  const { path: rawPath, suffix } = splitPathSuffix(trimmed);
  if (path.isAbsolute(rawPath)) {
    return `${normalizeRecordPath(root, rawPath)}${suffix}`;
  }
  return toPosixPath(trimmed);
};

const normalizeEvidenceEntries = (root: string, value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => normalizeEvidenceEntry(root, entry));
  return [...new Set(normalized)];
};

const resolveHoldoutGateIds = async ({
  store,
  blockId,
}: {
  store: string;
  blockId?: string | null;
}): Promise<string[]> => {
  const tasks = await resolveHoldoutTasks(
    blockId === undefined ? { store } : { store, blockId },
  );
  return tasks
    .map((task) => normalizeHoldoutGateId(task.id))
    .filter(Boolean);
};

const isHoldoutArtifact = (artifactPath: string, holdoutId: string): boolean => {
  const base = path.posix.basename(artifactPath);
  return base.startsWith(`${holdoutId}-`);
};

const normalizeGateEvidence = (
  root: string,
  gateEvidence: Record<string, unknown>,
): EvalGateEvidence => {
  const result = asRecord(gateEvidence["result"]);
  const artifactsRaw = Array.isArray(gateEvidence["artifacts"])
    ? gateEvidence["artifacts"]
    : null;
  const runRef = asRecord(gateEvidence["run_ref"]);
  const normalizedArtifacts = artifactsRaw
    ? artifactsRaw.map((entry) => {
        const artifact = asRecord(entry);
        if (!artifact) return entry as EvalGateArtifactEvidence;
        const rawPath =
          typeof artifact["path"] === "string" ? artifact["path"].trim() : "";
        const sha =
          typeof artifact["sha256"] === "string" ? artifact["sha256"].trim() : "";
        if (!rawPath) return entry as EvalGateArtifactEvidence;
        return {
          ...(sha ? { sha256: sha } : {}),
          path: normalizeRecordPath(root, rawPath),
        } as EvalGateArtifactEvidence;
      })
    : null;

  const runRefLine = runRef ? Number(runRef["line"]) : NaN;
  const runRefPath =
    runRef && typeof runRef["path"] === "string" ? runRef["path"].trim() : "";
  const normalizedRunRef =
    runRefPath && Number.isFinite(runRefLine)
      ? { path: normalizeRecordPath(root, runRefPath), line: runRefLine }
      : null;

  const normalized: Partial<EvalGateEvidence> = {};
  if (typeof gateEvidence["mode"] === "string") {
    normalized.mode = gateEvidence["mode"] as "full";
  }
  if (result && typeof result["ok"] === "boolean") {
    normalized.result = { ok: result["ok"] };
  }
  const obligationsHash =
    typeof gateEvidence["obligations_hash"] === "string"
      ? gateEvidence["obligations_hash"].trim()
      : "";
  if (obligationsHash) {
    normalized.obligations_hash = obligationsHash;
  }
  if (normalizedArtifacts) {
    normalized.artifacts = normalizedArtifacts;
  }
  if (normalizedRunRef) {
    normalized.run_ref = normalizedRunRef;
  }
  return normalized as EvalGateEvidence;
};

const normalizePackRef = (
  root: string,
  value: Record<string, unknown>,
): CyclePackRef | null => {
  const kind = String(value["kind"] ?? "").trim();
  const cycleId = String(value["cycle_id"] ?? "").trim();
  const pathRaw = String(value["path"] ?? "").trim();
  const sha = String(value["sha256"] ?? "").trim();
  const manifestRaw = String(value["manifest_path"] ?? "").trim();
  if (!kind || !cycleId || !pathRaw || !sha || !manifestRaw) return null;
  return {
    kind: kind as CyclePackRef["kind"],
    cycle_id: cycleId,
    path: normalizeRecordPath(root, pathRaw),
    sha256: sha,
    manifest_path: normalizeRecordPath(root, manifestRaw),
  };
};

const normalizePackVerifyRef = (
  root: string,
  value: Record<string, unknown>,
): PackVerifyRef | null => {
  const kind = String(value["kind"] ?? "").trim();
  const cycleId = String(value["cycle_id"] ?? "").trim();
  const pathRaw = String(value["path"] ?? "").trim();
  const sha = String(value["sha256"] ?? "").trim();
  const ok = value["ok"];
  if (!kind || !cycleId || !pathRaw || !sha || typeof ok !== "boolean") return null;
  return {
    kind: kind as PackVerifyRef["kind"],
    cycle_id: cycleId,
    path: normalizeRecordPath(root, pathRaw),
    sha256: sha,
    ok,
  };
};

const hasQDoneEvidence = (entries: string[]): boolean =>
  entries.some((entry) => entry.toLowerCase().includes("q-done"));

const hasCycleFinishAcceptanceCheck = (entries: string[]): boolean =>
  entries.some((entry) => /\bcycle\s+finish\b/i.test(entry));

const isAbsoluteEvidencePath = (entry: string): boolean => {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.startsWith("cmd:")) return false;
  const prefixMatch = trimmed.match(/^(file|output):(.+)$/);
  const candidate = prefixMatch && prefixMatch[2] ? prefixMatch[2] : trimmed;
  const { path: rawPath } = splitPathSuffix(candidate.trim());
  return path.isAbsolute(rawPath);
};

const annotateEvalCycleIntegrity = (record: EvalCycleRecord): EvalCycleRecord => {
  if (record.integrity) return record;
  const issues = [];
  if (!record.selection_evidence) issues.push("missing selection_evidence");
  if (!record.gate_evidence) issues.push("missing gate_evidence");
  if (!record.preflight_evidence) issues.push("missing preflight_evidence");
  if (!issues.length) return record;
  return {
    ...record,
    integrity: { status: "invalid", issues },
  };
};

export const buildEvalCheckCatalog = (
  config: AtoConfig,
): EvalCheckCatalogEntry[] => {
  const gates = config.gates ?? {};
  const catalog: EvalCheckCatalogEntry[] = [];

  for (const gate of gates.fast ?? []) {
    const cmd = normalizeCmd(gate);
    if (!cmd.length) continue;
    catalog.push({ id: gate.id, mode: "fast", cmd });
  }

  const tests = gates.full?.tests ?? {};
  const rootGates = tests.root ?? [];
  for (const gate of rootGates) {
    const cmd = normalizeCmd(gate);
    if (!cmd.length) continue;
    catalog.push({ id: gate.id, mode: "full", scope: "root", cmd });
  }

  const orderedScopes = Array.isArray(tests.order) ? tests.order.slice() : [];
  const scopeMap = tests.scopes ?? {};
  const scopedKeys = Object.keys(scopeMap).sort();
  for (const key of scopedKeys) {
    if (!orderedScopes.includes(key)) orderedScopes.push(key);
  }

  for (const scope of orderedScopes) {
    const scoped = scopeMap[scope] ?? [];
    for (const gate of scoped) {
      const cmd = normalizeCmd(gate);
      if (!cmd.length) continue;
      catalog.push({ id: gate.id, mode: "full", scope, cmd });
    }
  }

  return catalog;
};

export const initEvalStore = async ({
  store,
  config,
  targetId,
}: {
  store: string;
  config: AtoConfig;
  targetId?: string;
}): Promise<EvalConfig> => {
  await ensureDir(evalDir(store));
  const existingConfig = await readJson<EvalConfig>(evalConfigPath(store), null);
  const checks = buildEvalCheckCatalog(config);
  const nextConfig: EvalConfig =
    existingConfig ?? {
      version: 1,
      ...(targetId ? { target_id: targetId } : {}),
      ...(checks.length ? { checks } : {}),
    };

  if (!existingConfig) {
    await writeJson(evalConfigPath(store), nextConfig);
  }

  const ledgerExists = await fileExists(evalLedgerPath(store));
  if (!ledgerExists) {
    await writeJsonl(evalLedgerPath(store), []);
  }

  const existingScorecard = await readJson<EvalScorecard>(
    evalScorecardPath(store),
    null,
  );
  if (!existingScorecard) {
    const scorecard = computeEvalScorecard([]);
    await writeJson(evalScorecardPath(store), scorecard);
  }

  return nextConfig;
};

export const ensureEvalStore = async ({
  store,
  config,
  targetId,
}: {
  store: string;
  config: AtoConfig;
  targetId?: string;
}): Promise<{
  config: EvalConfig;
  paths: { dir: string; config: string; ledger: string; scorecard: string };
}> => {
  const initArgs: { store: string; config: AtoConfig; targetId?: string } = {
    store,
    config,
  };
  if (targetId) {
    initArgs.targetId = targetId;
  }
  const evalConfig = await initEvalStore(initArgs);
  return {
    config: evalConfig,
    paths: {
      dir: evalDir(store),
      config: evalConfigPath(store),
      ledger: evalLedgerPath(store),
      scorecard: evalScorecardPath(store),
    },
  };
};

export const readEvalCycles = async (store: string): Promise<EvalCycleRecord[]> => {
  const records = await readJsonl<EvalCycleRecord>(evalLedgerPath(store));
  return records.map((record) => annotateEvalCycleIntegrity(record.item));
};

export const normalizeEvalCycleInput = ({
  input,
  fallbackId,
  root,
}: {
  input: unknown;
  fallbackId: string;
  root: string;
}): EvalCycleRecord => {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const hypothesis = source["hypothesis"] ? String(source["hypothesis"]).trim() : "";
  const acceptanceChecks = normalizeStringArray(source["acceptance_checks"]);
  const evidence = normalizeEvidenceEntries(root, source["evidence"]);
  const queueId = source["queue_id"] ? String(source["queue_id"]).trim() : "";
  const cycleIndex = Number(source["cycle_index"]);

  const record = {
    id: source["id"] ? String(source["id"]).trim() : fallbackId,
    ts: source["ts"] ? String(source["ts"]).trim() : "",
    hypothesis,
    acceptance_checks: acceptanceChecks,
    evidence,
    ...(queueId ? { queue_id: queueId } : {}),
  } as EvalCycleRecord;

  if (Number.isFinite(cycleIndex) && cycleIndex > 0) {
    record.cycle_index = cycleIndex;
  }

  if (typeof source["outcome"] === "string") {
    record.outcome = source["outcome"] as EvalOutcome;
  }
  if (source["negative_report"] && typeof source["negative_report"] === "object") {
    const negativeSource = source["negative_report"] as Record<string, unknown>;
    const type = negativeSource["type"]
      ? String(negativeSource["type"]).trim()
      : "";
    const summary = negativeSource["summary"]
      ? String(negativeSource["summary"]).trim()
      : "";
    const evidenceItems = normalizeEvidenceEntries(
      root,
      negativeSource["evidence"],
    );
    record.negative_report = {
      type: type as EvalNegativeReportType,
      summary,
      evidence: evidenceItems,
    } as EvalNegativeReport;
  }
  if (source["seeding_result"] && typeof source["seeding_result"] === "object") {
    const seedSource = source["seeding_result"] as Record<string, unknown>;
    const outcome = String(seedSource["outcome"] ?? "").trim();
    const evidenceItems = normalizeEvidenceEntries(root, seedSource["evidence"]);
    if (outcome === "seeded") {
      const queueIds = normalizeStringArray(seedSource["queue_ids"]).filter(
        (id) => id.startsWith("BL-"),
      );
      const summary =
        typeof seedSource["summary"] === "string"
          ? seedSource["summary"].trim()
          : "";
      record.seeding_result = {
        outcome: "seeded",
        queue_ids: queueIds,
        evidence: evidenceItems,
        ...(summary ? { summary } : {}),
      };
    } else if (outcome === "no_seed") {
      const summary =
        typeof seedSource["summary"] === "string"
          ? seedSource["summary"].trim()
          : "";
      record.seeding_result = {
        outcome: "no_seed",
        summary,
        evidence: evidenceItems,
      };
    }
  }
  if (source["supersedes"] && typeof source["supersedes"] === "object") {
    const supersedes = source["supersedes"] as Record<string, unknown>;
    const id = typeof supersedes["id"] === "string" ? supersedes["id"].trim() : "";
    const reason =
      typeof supersedes["reason"] === "string"
        ? supersedes["reason"].trim()
        : "";
    const evidenceItems = normalizeEvidenceEntries(root, supersedes["evidence"]);
    if (id && reason && evidenceItems.length) {
      record.supersedes = { id, reason, evidence: evidenceItems };
    }
  }
  if (source["override"] && typeof source["override"] === "object") {
    const override = source["override"] as Record<string, unknown>;
    const expectedQueueId =
      typeof override["expected_queue_id"] === "string"
        ? override["expected_queue_id"].trim()
        : "";
    const actualQueueId =
      typeof override["actual_queue_id"] === "string"
        ? override["actual_queue_id"].trim()
        : "";
    const reason =
      typeof override["reason"] === "string" ? override["reason"].trim() : "";
    const evidenceItems = normalizeEvidenceEntries(root, override["evidence"]);
    if (expectedQueueId && actualQueueId && reason && evidenceItems.length) {
      record.override = {
        expected_queue_id: expectedQueueId,
        actual_queue_id: actualQueueId,
        reason,
        evidence: evidenceItems,
      };
    }
  }
  if (typeof source["telemetry_snapshot_ref"] === "string") {
    const ref = source["telemetry_snapshot_ref"].trim();
    if (ref) record.telemetry_snapshot_ref = ref;
  }
  if (typeof source["telemetry_missing"] === "boolean") {
    record.telemetry_missing = source["telemetry_missing"];
  }
  const telemetrySummary = asRecord(source["telemetry_summary"]);
  if (telemetrySummary) {
    const tokensTotal = Number(telemetrySummary["tokens_total"]);
    const toolCallsTotal = Number(telemetrySummary["tool_calls_total"]);
    const shellCommandsTotal = Number(telemetrySummary["shell_commands_total"]);
    if (
      Number.isFinite(tokensTotal) &&
      Number.isFinite(toolCallsTotal) &&
      Number.isFinite(shellCommandsTotal)
    ) {
      record.telemetry_summary = {
        tokens_total: tokensTotal,
        tool_calls_total: toolCallsTotal,
        shell_commands_total: shellCommandsTotal,
      };
    }
  }
  const selectionEvidence = asRecord(source["selection_evidence"]);
  if (selectionEvidence) {
    record.selection_evidence = selectionEvidence as EvalSelectionEvidence;
    if (!record.cycle_index) {
      const inferredIndex = Number(selectionEvidence["cycle_index"]);
      if (Number.isFinite(inferredIndex) && inferredIndex > 0) {
        record.cycle_index = inferredIndex;
      }
    }
  }
  const gateEvidence = asRecord(source["gate_evidence"]);
  if (gateEvidence) {
    record.gate_evidence = normalizeGateEvidence(root, gateEvidence);
  }
  const preflightEvidence = asRecord(source["preflight_evidence"]);
  if (preflightEvidence) {
    const rawPath = String(preflightEvidence["path"] ?? "").trim();
    const sha = String(preflightEvidence["sha256"] ?? "").trim();
    if (rawPath && sha) {
      record.preflight_evidence = {
        path: normalizeRecordPath(root, rawPath),
        sha256: sha,
      };
    }
  }
  const packRef = asRecord(source["pack_ref"]);
  if (packRef) {
    const normalized = normalizePackRef(root, packRef);
    if (normalized) record.pack_ref = normalized;
  }
  const packVerifyRef = asRecord(source["pack_verify_ref"]);
  if (packVerifyRef) {
    const normalized = normalizePackVerifyRef(root, packVerifyRef);
    if (normalized) record.pack_verify_ref = normalized;
  }
  const integrity = asRecord(source["integrity"]);
  if (integrity) {
    const status = String(integrity["status"] ?? "").trim();
    if (status) {
      record.integrity = {
        status: status as EvalCycleIntegrity["status"],
        issues: normalizeStringArray(integrity["issues"]),
      };
    }
  }
  if (Array.isArray(source["checks"])) {
    record.checks = source["checks"] as EvalCheckRecord[];
  }

  return record;
};

export const validateEvalCycle = async ({
  record,
  root,
  store,
}: {
  record: EvalCycleRecord;
  root: string;
  store?: string;
}): Promise<{ ok: boolean; errors: string[]; guidance: string[] }> => {
  const schema = await loadEvalSchema();
  const ajv = createAjv();
  ajv.addFormat("date-time", isIsoDate);
  const validate = ajv.compile(schema);
  const schemaOk = validate(record);
  const errors: string[] = [];
  const guidance = new Set<string>();
  if (!schemaOk) {
    for (const error of validate.errors ?? []) {
      errors.push(`${error.instancePath} ${error.message}`);
    }
  }

  const evidenceEntries = record.evidence ?? [];
  const acceptanceEntries = record.acceptance_checks ?? [];
  if (hasQDoneEvidence(evidenceEntries) && !hasCycleFinishAcceptanceCheck(acceptanceEntries)) {
    errors.push(
      "acceptance_checks must include cycle finish when q-done evidence is recorded.",
    );
    guidance.add("Include the `ato cycle finish ...` command in acceptance_checks.");
  }
  const negativeEvidence = record.negative_report?.evidence ?? [];
  const absoluteEvidence = [...evidenceEntries, ...negativeEvidence].filter(
    isAbsoluteEvidencePath,
  );
  if (absoluteEvidence.length) {
    errors.push("evidence paths must be repo-relative (no absolute paths).");
    guidance.add("Replace absolute evidence paths with repo-relative paths.");
  }

  const gateEvidence = record.gate_evidence;
  if (!gateEvidence) {
    errors.push("gate_evidence is required for eval cycle records.");
    guidance.add(
      "Attach full gate artifacts with sha256 hashes.",
    );
  } else {
    if (gateEvidence.mode !== "full") {
      errors.push("gate_evidence.mode must be 'full'.");
      guidance.add("Provide full gate evidence for eval cycles.");
    }
    let artifacts = Array.isArray(gateEvidence.artifacts)
      ? gateEvidence.artifacts
      : null;
    let result = gateEvidence.result ?? null;
    const runRef = asRecord(gateEvidence.run_ref);
    const runRefPath =
      runRef && typeof runRef["path"] === "string" ? runRef["path"].trim() : "";
    if (runRefPath && path.isAbsolute(runRefPath)) {
      errors.push("gate_evidence.run_ref.path must be repo-relative.");
      guidance.add("Normalize gate_evidence.run_ref.path to a repo-relative path.");
    }

    if ((!artifacts || artifacts.length === 0) && runRef) {
      const runPathRaw = typeof runRef["path"] === "string" ? runRef["path"].trim() : "";
      const runLine = Number(runRef["line"]);
      if (!runPathRaw || !Number.isFinite(runLine) || runLine < 1) {
        errors.push("gate_evidence.run_ref must include path and line.");
      } else {
        try {
          const runLogPath = resolvePath(root, runPathRaw);
          const raw = await fs.readFile(runLogPath, "utf8");
          const lines = raw
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0);
          const entryRaw = lines[runLine - 1];
          if (!entryRaw) {
            errors.push(`gate_evidence.run_ref line ${runLine} not found.`);
          } else {
            const entry = asRecord(JSON.parse(entryRaw));
            const kind = entry ? String(entry["kind"] ?? "") : "";
            const mode = entry ? String(entry["mode"] ?? "") : "";
            if (kind !== "gate_run") {
              errors.push("gate_evidence.run_ref must reference gate_run entry.");
            }
            if (mode !== "full") {
              errors.push("gate_evidence.run_ref must reference a full gate run.");
            }

            const commands = entry && Array.isArray(entry["commands"]) ? entry["commands"] : [];
            let inferredOk: boolean | null = null;
            if (commands.length) {
              let ok = true;
              for (const command of commands) {
                const commandObj = asRecord(command);
                const exitCode = commandObj ? Number(commandObj["exitCode"]) : NaN;
                if (!Number.isFinite(exitCode)) {
                  ok = false;
                  inferredOk = null;
                  break;
                }
                if (exitCode !== 0) ok = false;
                inferredOk = ok;
              }
            }

            const artifactList =
              entry && Array.isArray(entry["artifacts"]) ? entry["artifacts"] : [];
            const artifactPaths = artifactList
              .map((item) => String(item))
              .filter((item) => item.length > 0);
            if (!artifactPaths.length) {
              errors.push("gate_evidence.run_ref has no artifacts to hash.");
            } else {
              const resolved = [];
              for (const item of artifactPaths) {
                const normalizedPath = normalizeRecordPath(root, item);
                const resolvedPath = resolvePath(root, normalizedPath);
                const sha = await hashFile(resolvedPath);
                resolved.push({ path: normalizedPath, sha256: sha });
              }
              artifacts = resolved;
              gateEvidence.artifacts = resolved;
            }

            if (inferredOk === null) {
              errors.push("gate_evidence.run_ref missing gate result exit codes.");
            } else if (!result) {
              result = { ok: inferredOk };
              gateEvidence.result = result;
            } else if (result.ok !== inferredOk) {
              errors.push("gate_evidence.result.ok mismatch with run_ref.");
            }
          }
        } catch (error) {
          errors.push(
            `gate_evidence.run_ref could not be resolved: ${
              (error as Error).message
            }`,
          );
        }
      }
    }

    if (!artifacts || artifacts.length === 0) {
      errors.push("gate_evidence.artifacts must include full gate artifacts.");
    }
    if (!result || typeof result.ok !== "boolean") {
      errors.push("gate_evidence.result.ok is required.");
    }
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        const artifactObj = asRecord(artifact);
        const rawPath = artifactObj ? String(artifactObj["path"] ?? "") : "";
        const sha = artifactObj ? String(artifactObj["sha256"] ?? "") : "";
        if (!rawPath || !sha) {
          errors.push("gate_evidence.artifacts entries must include path + sha256.");
          continue;
        }
        if (path.isAbsolute(rawPath)) {
          errors.push("gate_evidence.artifacts paths must be repo-relative.");
        }
        try {
          const resolvedPath = resolvePath(root, rawPath);
          const actual = await hashFile(resolvedPath);
          if (actual !== sha) {
            errors.push(`gate_evidence sha256 mismatch for ${rawPath}.`);
          }
        } catch (error) {
          errors.push(
            `gate_evidence artifact unavailable for ${rawPath}: ${
              (error as Error).message
            }`,
          );
        }
      }
    }
  }

  if (store && gateEvidence?.artifacts?.length) {
    const blockId = record.selection_evidence?.seed?.block_id ?? null;
    const holdoutIds = await resolveHoldoutGateIds({ store, blockId });
    if (blockId && holdoutIds.length === 0) {
      errors.push("holdout tasks missing for active block.");
      guidance.add(
        "Define holdout.tasks in the active block file before recording cycles.",
      );
    } else if (holdoutIds.length) {
      const missing = holdoutIds.filter((holdoutId) =>
        gateEvidence.artifacts
          ? gateEvidence.artifacts.every(
              (artifact) => !isHoldoutArtifact(String(artifact.path), holdoutId),
            )
          : true,
      );
      if (missing.length) {
        errors.push(
          `holdout artifacts missing for: ${missing.join(", ")}`,
        );
        guidance.add(
          "Ensure full gate execution includes holdout tasks for the active block.",
        );
      }
    }
  }

  const integrityIssues: string[] = [];
  const preflightEvidence = record.preflight_evidence;
  if (!preflightEvidence) {
    integrityIssues.push("missing preflight_evidence");
  } else {
    const rawPath = String(preflightEvidence.path ?? "").trim();
    const sha = String(preflightEvidence.sha256 ?? "").trim();
    if (!rawPath || !sha) {
      errors.push("preflight_evidence must include path + sha256.");
    } else {
      if (path.isAbsolute(rawPath)) {
        errors.push("preflight_evidence.path must be repo-relative.");
        guidance.add("Normalize preflight_evidence.path to a repo-relative path.");
      }
      try {
        const resolvedPath = resolvePath(root, rawPath);
        const actual = await hashFile(resolvedPath);
        if (actual !== sha) {
          errors.push(`preflight_evidence sha256 mismatch for ${rawPath}.`);
        }
      } catch (error) {
        errors.push(
          `preflight_evidence artifact unavailable for ${rawPath}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }

  const packRef = record.pack_ref;
  if (!packRef) {
    errors.push("pack_ref is required for eval cycle records.");
    guidance.add("Ensure cycle finish emits an evidence pack with pack_ref.");
  } else {
    const packPath = String(packRef.path ?? "").trim();
    const packSha = String(packRef.sha256 ?? "").trim();
    const manifestPath = String(packRef.manifest_path ?? "").trim();
    if (packRef.kind !== "cycle_pack") {
      errors.push("pack_ref.kind must be 'cycle_pack'.");
    }
    if (packRef.cycle_id !== record.id) {
      errors.push("pack_ref.cycle_id must match the cycle id.");
    }
    if (!packPath || !packSha) {
      errors.push("pack_ref must include path + sha256.");
    } else {
      if (path.isAbsolute(packPath) || packPath.startsWith("..")) {
        errors.push("pack_ref.path must be repo-relative.");
      }
      try {
        const resolvedPath = resolvePath(root, packPath);
        const actual = await hashFile(resolvedPath);
        if (actual !== packSha) {
          errors.push(`pack_ref sha256 mismatch for ${packPath}.`);
        }
      } catch (error) {
        errors.push(
          `pack_ref artifact unavailable for ${packPath}: ${
            (error as Error).message
          }`,
        );
      }
    }
    if (!manifestPath) {
      errors.push("pack_ref.manifest_path is required.");
    } else if (path.isAbsolute(manifestPath) || manifestPath.startsWith("..")) {
      errors.push("pack_ref.manifest_path must be repo-relative.");
    } else {
      try {
        const resolvedPath = resolvePath(root, manifestPath);
        await fs.access(resolvedPath);
      } catch (error) {
        errors.push(
          `pack_ref manifest unavailable for ${manifestPath}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }

  const packVerifyRef = record.pack_verify_ref;
  if (!packVerifyRef) {
    errors.push("pack_verify_ref is required for eval cycle records.");
    guidance.add("Ensure cycle finish verifies the evidence pack.");
  } else {
    const verifyPath = String(packVerifyRef.path ?? "").trim();
    const verifySha = String(packVerifyRef.sha256 ?? "").trim();
    if (packVerifyRef.kind !== "pack_verify") {
      errors.push("pack_verify_ref.kind must be 'pack_verify'.");
    }
    if (packVerifyRef.cycle_id !== record.id) {
      errors.push("pack_verify_ref.cycle_id must match the cycle id.");
    }
    if (!verifyPath || !verifySha) {
      errors.push("pack_verify_ref must include path + sha256.");
    } else {
      if (path.isAbsolute(verifyPath) || verifyPath.startsWith("..")) {
        errors.push("pack_verify_ref.path must be repo-relative.");
      }
      try {
        const resolvedPath = resolvePath(root, verifyPath);
        const actual = await hashFile(resolvedPath);
        if (actual !== verifySha) {
          errors.push(`pack_verify_ref sha256 mismatch for ${verifyPath}.`);
        }
        const verifyPayload = await readJson<Record<string, unknown>>(
          resolvedPath,
          null,
        );
        if (!verifyPayload || verifyPayload["schema_version"] !== "pack-verify.v1") {
          errors.push("pack_verify_ref payload must match pack-verify.v1.");
        } else {
          const payloadOk =
            typeof verifyPayload["ok"] === "boolean"
              ? verifyPayload["ok"]
              : null;
          if (payloadOk !== packVerifyRef.ok) {
            errors.push("pack_verify_ref.ok must match pack verify output.");
          }
          const payloadCycle =
            typeof verifyPayload["cycle_id"] === "string"
              ? verifyPayload["cycle_id"]
              : "";
          if (payloadCycle && payloadCycle !== record.id) {
            errors.push("pack verify payload cycle_id must match record id.");
          }
          if (record.outcome !== "inconclusive" && payloadOk !== true) {
            errors.push("pack_verify_ref.ok must be true for non-inconclusive cycles.");
          }
        }
      } catch (error) {
        errors.push(
          `pack_verify_ref artifact unavailable for ${verifyPath}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }

  if (integrityIssues.length) {
    const issues = new Set([...(record.integrity?.issues ?? [])]);
    for (const issue of integrityIssues) issues.add(issue);
    const status =
      record.integrity?.status && record.integrity.status !== "ok"
        ? record.integrity.status
        : "degraded";
    record.integrity = {
      status,
      issues: [...issues].sort((a, b) => a.localeCompare(b)),
    };
  } else if (!record.integrity) {
    record.integrity = { status: "ok" };
  }

  return { ok: errors.length === 0, errors, guidance: [...guidance] };
};

const inferCheckStatus = (
  check: EvalCheckRecord,
): "ok" | "fail" | "skipped" | "unknown" => {
  if (check.status) return check.status;
  if (typeof check.exitCode === "number") {
    return check.exitCode === 0 ? "ok" : "fail";
  }
  return "unknown";
};

export const computeEvalScorecard = (
  records: EvalCycleRecord[],
): EvalScorecard => {
  const outcomes = { ok: 0, fail: 0, inconclusive: 0, unknown: 0 };
  const checks = { total: 0, ok: 0, fail: 0, skipped: 0, unknown: 0 };
  const telemetry = {
    cycles_total: records.length,
    cycles_with_summary: 0,
    cycles_with_snapshot_ref: 0,
    cycles_missing: 0,
    cycles_unknown: 0,
    tokens_total: 0,
    tool_calls_total: 0,
    shell_commands_total: 0,
  };

  for (const record of records) {
    const outcome = record.outcome ?? "unknown";
    if (outcome in outcomes) {
      outcomes[outcome as keyof typeof outcomes] += 1;
    } else {
      outcomes.unknown += 1;
    }

    for (const check of record.checks ?? []) {
      checks.total += 1;
      const status = inferCheckStatus(check);
      if (status in checks) {
        checks[status as keyof typeof checks] += 1;
      } else {
        checks.unknown += 1;
      }
    }

    const hasSummary = Boolean(record.telemetry_summary);
    const hasSnapshot = Boolean(record.telemetry_snapshot_ref);
    const isMissing = record.telemetry_missing === true;
    if (hasSummary) {
      telemetry.cycles_with_summary += 1;
      telemetry.tokens_total += record.telemetry_summary?.tokens_total ?? 0;
      telemetry.tool_calls_total += record.telemetry_summary?.tool_calls_total ?? 0;
      telemetry.shell_commands_total +=
        record.telemetry_summary?.shell_commands_total ?? 0;
    }
    if (hasSnapshot) telemetry.cycles_with_snapshot_ref += 1;
    if (isMissing) telemetry.cycles_missing += 1;
    if (!hasSummary && !hasSnapshot && !isMissing) {
      telemetry.cycles_unknown += 1;
    }
  }

  const last = records.length ? records[records.length - 1] : null;
  return {
    version: 1,
    cycles: records.length,
    outcomes,
    checks,
    telemetry,
    last_cycle_id: last ? last.id : null,
  };
};

export const writeEvalScorecard = async ({
  store,
  records,
}: {
  store: string;
  records: EvalCycleRecord[];
}): Promise<EvalScorecard> => {
  const scorecard = computeEvalScorecard(records);
  await writeJson(evalScorecardPath(store), scorecard);
  return scorecard;
};

export const readEvalScorecard = async (
  store: string,
): Promise<EvalScorecard> => {
  const scorecard = await readJson<EvalScorecard>(
    evalScorecardPath(store),
    null,
  );
  if (scorecard) return scorecard;
  const ledgerExists = await fileExists(evalLedgerPath(store));
  if (!ledgerExists) return computeEvalScorecard([]);
  const records = await readEvalCycles(store);
  return writeEvalScorecard({ store, records });
};

export const appendEvalCycle = async ({
  store,
  record,
}: {
  store: string;
  record: EvalCycleRecord;
}): Promise<EvalScorecard> => {
  const records = await readEvalCycles(store);
  if (records.some((entry) => entry.id === record.id)) {
    throw new Error(`cycle id '${record.id}' already exists.`);
  }
  if (record.supersedes) {
    const supersedesId = record.supersedes.id;
    const exists = records.some((entry) => entry.id === supersedesId);
    if (!exists) {
      throw new Error(`supersedes target '${supersedesId}' not found.`);
    }
  }
  await appendJsonl(evalLedgerPath(store), record);
  const updated = await readEvalCycles(store);
  return writeEvalScorecard({ store, records: updated });
};
