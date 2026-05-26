import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { readQueueItems, writeQueueItems } from "../../core/queue/store.js";
import { validateQueueItems } from "../../core/queue/validate.js";
import {
  citationPrefixCarriesPath,
  isAbsoluteCitationPath,
  INPUT_CITATION_PREFIX_MESSAGE,
  parseInputCitation,
} from "../../core/queue/citations.js";
import {
  computeCoreHash,
  normalizeEvidence,
} from "../../core/queue/transitions.js";
import { writeViews } from "./q.js";
import { readState, writeState } from "../../core/state.js";
import { buildSelectionFailureGuidance } from "../../core/state/transitions.js";
import { writeJson as writeJsonFile, readJson, readJsonl } from "../../core/fs.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { runPluginHooks } from "../../core/plugins/runner.js";
import { parseEnvPrefix } from "../../core/exec.js";
import {
  buildContractIndex,
  resolveAliasMatches,
  resolveContractDocs,
  resolveSectionFromIndex,
  toContractDocKey,
} from "../../core/contracts/index.js";
import { extractSection } from "../../core/contracts/extract.js";
import type { ContractEntry, ContractIndex } from "../../core/contracts/index.js";
import { captureCyclePreflight } from "../../core/cycle/preflight.js";
import {
  buildCycleEvidencePack,
  verifyCycleEvidencePack,
} from "../../core/cycle/pack.js";
import type { PackVerifyResult } from "../../core/cycle/pack.js";
import {
  buildCycleSelectionEvidence,
  selectCycleQueueItem,
} from "../../core/cycle/select.js";
import type { CycleSelection } from "../../core/cycle/select.js";
import { appendCycleRecord, readCycleRecords } from "../../core/cycle/store.js";
import { runGates } from "../../core/gates/runner.js";
import { resolveGateEnv } from "../../core/gates/env.js";
import { recommendGateMode } from "../../core/gates/recommend.js";
import { resolveTarget, TargetError } from "../../core/targets/resolve.js";
import {
  readLessonItems,
  writeLessonItems,
  nextLessonId,
  normalizeLessonInput,
  validateLessonItem,
} from "../../core/learning/lessons.js";
import { readPatternItems } from "../../core/learning/patterns.js";
import { suggestLessons, suggestPatterns } from "../../core/learning/suggest.js";
import { recordSuggestion } from "../../core/learning/suggestions.js";
import {
  loadBlockConfig,
  resolveBaselineTag,
  resolveBlockId,
  isBlockFrozen,
  resolveBlockState,
} from "../../core/blocks/config.js";
import { verifyBaselineRegistry } from "../../core/blocks/baseline.js";
import { computeGateObligations, verifyBlockSeal } from "../../core/blocks/seal.js";
import { gatherGitStatus } from "../../core/git/status.js";
import {
  buildBudgetExhaustedPayload,
  buildFinishProgressPayload,
} from "./cycle-finish-budget.js";
import type { CommandContext } from "../types.js";
import type {
  CycleCheckRecord,
  CycleRecord,
  JsonObject,
  JsonValue,
  LessonItem,
  ContractRef,
  QueueItem,
  QueueOrigin,
  QueueStatus,
  RunLogEntry,
  TargetContext,
} from "../../core/types.js";

const HELP = [
  "Usage:",
  "  ato cycle start",
  "  ato cycle abort --reason <text>",
  "  ato cycle preflight-finish",
  "  ato cycle finish",
  "",
  "Options:",
  "  --json         Emit machine-readable JSON",
  "  --reason       Required when aborting a cycle",
  "  --budget-ms    Time budget for cycle finish (default: 9000)",
  "  --check-only   Run finish preflight checks without writing artifacts",
  "  --run-acceptance  Allow running acceptance commands during finish",
  "  --run-gate        Allow running full gate during finish",
  "  --run-pack-verify Allow running pack verify during finish",
].join("\n");

const CYCLE_START_SCHEMA = "cycle-start.v1";
const CYCLE_FINISH_SCHEMA = "cycle-finish.v1";
const CYCLE_ABORT_SCHEMA = "cycle-abort.v1";
const CYCLE_ABORT_ERROR_SCHEMA = "cycle-abort-error.v1";
const CYCLE_FINISH_PREFLIGHT_SCHEMA = "cycle-finish-preflight.v1";
const CYCLE_STATE_SCHEMA = "cycle-state.v1";
const CYCLE_SELECTION_SCHEMA = "cycle-selection.v1";
const CONTRACT_INDEX_SCHEMA = "cycle-contract-index.v1";
const CONTRACT_EXTRACT_SCHEMA = "cycle-contract-extract.v1";
const DEFAULT_CYCLE_FINISH_BUDGET_MS = 9000;

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const toRelativePath = (root: string, filePath: string): string => {
  const rel = path.relative(root, filePath) || filePath;
  return toPosixPath(rel);
};

const looksAbsolutePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    /(^|[^A-Za-z0-9])\/(home|Users)\//.test(trimmed) ||
    /^[A-Za-z]:\\/.test(trimmed)
  );
};

const toSafeRelativePath = (root: string, filePath: string): string => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel === "." || rel.startsWith("..")) return "<redacted>";
  return toPosixPath(rel);
};

const normalizeArtifactPath = (root: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!looksAbsolutePath(trimmed)) return toPosixPath(trimmed);
  return toSafeRelativePath(root, trimmed);
};

const redactAbsolutePaths = (value: JsonValue, root: string): JsonValue => {
  if (typeof value === "string") {
    if (!looksAbsolutePath(value)) return value;
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
      return toSafeRelativePath(root, value);
    }
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAbsolutePaths(entry, root));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return entries.reduce<Record<string, JsonValue>>((acc, [key, entry]) => {
      acc[key] = redactAbsolutePaths(entry, root);
      return acc;
    }, {});
  }
  return value;
};

const toJsonValue = (value: unknown, root: string): JsonValue => {
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as JsonValue;
    return redactAbsolutePaths(parsed, root);
  } catch {
    return { kind: "non_json" };
  }
};

const parseBudgetMs = (value: string | boolean | undefined): number => {
  if (value === undefined) return DEFAULT_CYCLE_FINISH_BUDGET_MS;
  if (typeof value !== "string") {
    throw new Error("Invalid --budget-ms value. Use a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid --budget-ms value. Use a positive integer.");
  }
  return Math.floor(parsed);
};

const isFlagEnabled = (value: string | boolean | undefined): boolean =>
  value === true || value === "true";

const isCycleCheckOk = (result: CycleCheckRecord): boolean => {
  if (typeof result.status === "string") return result.status === "ok";
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  return false;
};

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const hashStringSha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

type AcceptanceAuditEntry = {
  schema_version: "acceptance-audit-entry.v1";
  acceptance_id: string;
  raw: string;
  parsed_cmd: string[];
  env_overrides: Record<string, string>;
  command_identity?: string;
  exit_code: number | null;
  sha256_of_stdout: string | null;
  sha256_of_stderr: string | null;
};

const sortEnvEntries = (env: Record<string, string>): Array<[string, string]> =>
  Object.entries(env).sort(([a], [b]) => a.localeCompare(b));

const buildAcceptanceCommandIdentity = (entry: {
  raw: string;
  parsed_cmd: string[];
  env_overrides: Record<string, string>;
}): string =>
  hashStringSha256(
    JSON.stringify({
      raw: entry.raw.trim(),
      parsed_cmd: entry.parsed_cmd,
      env_overrides: sortEnvEntries(entry.env_overrides),
    }),
  );

const resolveAcceptanceCommandIdentity = (entry: AcceptanceAuditEntry): string =>
  typeof entry.command_identity === "string" && entry.command_identity.trim()
    ? entry.command_identity
    : buildAcceptanceCommandIdentity({
        raw: entry.raw,
        parsed_cmd: Array.isArray(entry.parsed_cmd) ? entry.parsed_cmd : [],
        env_overrides:
          entry.env_overrides && typeof entry.env_overrides === "object"
            ? entry.env_overrides
            : {},
      });

const readAcceptanceAudit = async (
  cycleDir: string,
): Promise<Map<string, AcceptanceAuditEntry>> => {
  const auditPath = path.join(cycleDir, "acceptance-audit.jsonl");
  let raw = "";
  try {
    raw = await fs.readFile(auditPath, "utf8");
  } catch {
    return new Map();
  }

  const map = new Map<string, AcceptanceAuditEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    const acceptanceId =
      typeof entry["acceptance_id"] === "string"
        ? entry["acceptance_id"]
        : "";
    if (!acceptanceId) continue;
    map.set(acceptanceId, entry as AcceptanceAuditEntry);
  }
  return map;
};

const acceptanceArtifactPaths = (cycleDir: string, index: number): string[] => {
  const padded = String(index).padStart(2, "0");
  return [
    path.join(cycleDir, `acceptance-${padded}.json`),
    path.join(cycleDir, `acceptance-${padded}.log`),
  ];
};

const clearAcceptanceArtifacts = async (
  cycleDir: string,
  index: number,
  keepPath?: string | null,
): Promise<void> => {
  const keep = keepPath ? path.resolve(keepPath) : null;
  for (const candidate of acceptanceArtifactPaths(cycleDir, index)) {
    if (keep && path.resolve(candidate) === keep) continue;
    try {
      await fs.unlink(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
};

const acceptanceArtifactCacheMatches = (
  previous: AcceptanceAuditEntry | null,
  current: AcceptanceAuditEntry,
): boolean => {
  if (!previous) return true;
  return resolveAcceptanceCommandIdentity(previous) === resolveAcceptanceCommandIdentity(current);
};

const resolveContractDoc = (
  config: TargetContext["config"],
): string | null => {
  const contracts = config.contracts;
  if (typeof contracts === "string") return contracts;
  if (Array.isArray(contracts)) return contracts[0] ?? null;
  if (contracts && typeof contracts === "object") {
    return contracts.platform ?? null;
  }
  return null;
};

const BLOCK_TITLE_RE = /\bblock-(\d{4,})\b/i;

const inferBlockIdFromTitle = (title: string | null | undefined): string | null => {
  if (!title) return null;
  const match = title.match(BLOCK_TITLE_RE);
  if (!match) return null;
  return `block-${match[1]}`.toLowerCase();
};

const resolveContractRef = (
  ref: ContractRef,
  config: TargetContext["config"],
): { doc: string; section: string } | null => {
  if (typeof ref === "string") {
    const doc = resolveContractDoc(config);
    if (!doc) return null;
    return { doc, section: ref };
  }
  if (
    ref &&
    typeof ref === "object" &&
    typeof ref.doc === "string" &&
    typeof ref.section === "string"
  ) {
    return { doc: ref.doc, section: ref.section };
  }
  return null;
};

const formatContractRef = (ref: ContractRef): string =>
  typeof ref === "string" ? ref : `${ref.doc}::${ref.section}`;

const ensureContractArtifacts = async ({
  target,
  cycleId,
  queueItem,
}: {
  target: TargetContext;
  cycleId: string;
  queueItem: QueueItem;
}): Promise<{
  contractIndexRel: string;
  contractExtractRel: string;
}> => {
  const refs = queueItem.spec?.contract_refs ?? [];
  if (!refs.length) {
    const error = new Error("Queue item missing contract_refs.");
    (error as Error & { code?: number; details?: unknown }).code = 6;
    (error as Error & { details?: unknown }).details = {
      queue_id: queueItem.id,
      missing_contract_refs: true,
      suggested_fix: [
        "Add spec.contract_refs to the queue item.",
        "Re-run: ato cycle start --json",
      ],
    };
    throw error;
  }

  const resolvedRefs: Array<{
    ref: ContractRef;
    doc: string;
    section: string;
    docPath: string;
    docKey: string;
  }> = [];
  const unresolvedRefs: string[] = [];
  for (const ref of refs) {
    const resolved = resolveContractRef(ref, target.config);
    if (!resolved?.doc || !resolved.section) {
      unresolvedRefs.push(formatContractRef(ref));
      continue;
    }
    const docPath = path.resolve(target.root, resolved.doc);
    const docKey = toContractDocKey(target.root, resolved.doc);
    resolvedRefs.push({
      ref,
      doc: resolved.doc,
      section: resolved.section,
      docPath,
      docKey,
    });
  }

  if (unresolvedRefs.length) {
    const error = new Error("Unable to resolve contract refs.");
    (error as Error & { code?: number; details?: unknown }).code = 6;
    (error as Error & { details?: unknown }).details = {
      queue_id: queueItem.id,
      unresolved_refs: unresolvedRefs,
      suggested_fix: [
        "Set spec.contract_refs to valid sections in configured contract docs.",
      ],
    };
    throw error;
  }

  const docs = resolveContractDocs(target.config, target.root);
  if (!docs.length) {
    const error = new Error("No contract docs configured for this repo.");
    (error as Error & { code?: number; details?: unknown }).code = 6;
    (error as Error & { details?: unknown }).details = {
      queue_id: queueItem.id,
      suggested_fix: [
        "Set config.contracts in .ato/config.json.",
        "Re-run: ato cycle start --json",
      ],
    };
    throw error;
  }

  const indexPath = path.join(target.storePath, "cache", "contracts.index.json");
  let index = await readJson<ContractIndex>(indexPath, null);
  const canonicalSection = (entry: ContractEntry): string =>
    entry.sectionNumber ?? entry.anchor ?? entry.heading;
  const resolveRefsWithIndex = (candidate: typeof index) => {
    const unresolved: Array<{ ref: string; doc: string; section: string }> = [];
    const ambiguous: Array<{ alias: string; candidates: string[] }> = [];
    if (!candidate) {
      for (const entry of resolvedRefs) {
        unresolved.push({
          ref: formatContractRef(entry.ref),
          doc: entry.doc,
          section: entry.section,
        });
      }
      return { unresolved, ambiguous };
    }
    for (const entry of resolvedRefs) {
      let resolvedEntry = resolveSectionFromIndex({
        index: candidate,
        doc: entry.docKey,
        section: entry.section,
      });
      if (!resolvedEntry) {
        const alias = typeof entry.ref === "string" ? entry.ref : entry.section;
        const aliasMatches = resolveAliasMatches({
          index: candidate,
          alias,
          doc: typeof entry.ref === "string" ? null : entry.doc,
        });
        if (aliasMatches.length === 1) {
          const match = aliasMatches[0];
          if (match) {
            const section = canonicalSection(match.entry);
            entry.doc = match.doc;
            entry.docKey = match.doc;
            entry.docPath = path.resolve(target.root, match.doc);
            entry.section = section;
            resolvedEntry = match.entry;
          }
        } else if (aliasMatches.length > 1) {
          const candidates = aliasMatches.map((match) => {
            const section = canonicalSection(match.entry);
            return `${match.doc}::${section}`;
          });
          ambiguous.push({ alias, candidates });
        }
      }
      if (!resolvedEntry) {
        unresolved.push({
          ref: formatContractRef(entry.ref),
          doc: entry.doc,
          section: entry.section,
        });
      }
    }
    return { unresolved, ambiguous };
  };

  let resolution = resolveRefsWithIndex(index);
  if (!index || resolution.unresolved.length || resolution.ambiguous.length) {
    const rebuilt = await buildContractIndex(docs);
    await writeJsonFile(indexPath, rebuilt);
    index = rebuilt;
    resolution = resolveRefsWithIndex(index);
  }

  if (resolution.ambiguous.length) {
    const error = new Error("Ambiguous contract refs.");
    (error as Error & { code?: number; details?: unknown }).code = 6;
    (error as Error & { details?: unknown }).details = {
      queue_id: queueItem.id,
      ambiguous_refs: resolution.ambiguous,
      suggested_fix: [
        'Use spec.contract_refs like [{"doc":"<doc-path>","section":"6.1"}].',
      ],
    };
    throw error;
  }

  if (resolution.unresolved.length) {
    const error = new Error("Unable to resolve contract refs after indexing.");
    (error as Error & { code?: number; details?: unknown }).code = 6;
    (error as Error & { details?: unknown }).details = {
      queue_id: queueItem.id,
      unresolved_refs: resolution.unresolved,
      suggested_fix: [
        "Update spec.contract_refs to valid sections or update contract docs.",
        "Re-run: ato cycle start --json",
      ],
    };
    throw error;
  }

  const cycleDir = path.join(target.storePath, "cycles", cycleId);
  const indexRel = toRelativePath(target.root, indexPath);
  const indexSha = await hashFileSha256(indexPath);
  const docsRel = docs.map((doc) => doc.path);

  const contractIndexPath = path.join(cycleDir, "contract-index.json");
  await writeJsonFile(contractIndexPath, {
    schema_version: CONTRACT_INDEX_SCHEMA,
    cycle_id: cycleId,
    queue_id: queueItem.id,
    index_path: indexRel,
    index_sha256: indexSha,
    docs: docsRel,
  });
  const contractIndexRel = toRelativePath(target.root, contractIndexPath);

  const sections = [];
  for (const entry of resolvedRefs) {
    const extracted = await extractSection({
      index,
      doc: entry.docPath,
      section: entry.section,
      docKey: entry.docKey,
    });
    if (!extracted) {
      continue;
    }
    sections.push({
      doc: toRelativePath(target.root, entry.docPath),
      section: entry.section,
      entry: {
        id: extracted.entry.id,
        heading: extracted.entry.heading,
        path: extracted.entry.path,
        anchor: extracted.entry.anchor,
        level: extracted.entry.level,
        line_start: extracted.entry.lineStart,
        line_end: extracted.entry.lineEnd,
        section_number: extracted.entry.sectionNumber,
      },
      content: extracted.content,
    });
  }

  const contractExtractPath = path.join(cycleDir, "contract-extract.json");
  await writeJsonFile(contractExtractPath, {
    schema_version: CONTRACT_EXTRACT_SCHEMA,
    cycle_id: cycleId,
    queue_id: queueItem.id,
    sections,
  });
  const contractExtractRel = toRelativePath(target.root, contractExtractPath);

  return { contractIndexRel, contractExtractRel };
};

const findLastDoneCycle = (
  records: CycleRecord[],
  blockId: string,
): CycleRecord | null => {
  const filtered = records.filter(
    (record) => record.outcome === "ok" && record.block_id === blockId,
  );
  return filtered.length ? filtered[filtered.length - 1] ?? null : null;
};

const verifyPriorGateArtifacts = async ({
  root,
  record,
}: {
  root: string;
  record: CycleRecord | null;
}): Promise<{
  ok: boolean;
  missing: Array<{ path: string }>;
  mismatched: Array<{ path: string; expected: string; actual: string }>;
}> => {
  if (!record) {
    return { ok: true, missing: [], mismatched: [] };
  }
  const artifacts = record.gate_evidence?.artifacts ?? [];
  const missing: Array<{ path: string }> = [];
  const mismatched: Array<{ path: string; expected: string; actual: string }> =
    [];
  for (const artifact of artifacts) {
    const rawPath = String(artifact.path ?? "").trim();
    const expected = String(artifact.sha256 ?? "").trim();
    if (!rawPath || !expected) continue;
    const resolved = path.resolve(root, rawPath);
    try {
      const actual = await hashFileSha256(resolved);
      if (actual !== expected) {
        mismatched.push({ path: rawPath, expected, actual });
      }
    } catch {
      missing.push({ path: rawPath });
    }
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
};

const loadQueueSchema = async (): Promise<JsonObject> => {
  const schemaUrl = new URL("../../core/schemas/queue.v2.json", import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw) as JsonObject;
};

const loadQueueForWrite = async (
  target: TargetContext,
): Promise<{
  items: QueueItem[];
  validation: Awaited<ReturnType<typeof validateQueueItems>>;
}> => {
  const records = await readQueueItems(target.storePath);
  const items = records.map((record) => record.item);
  const schema = await loadQueueSchema();
  const validation = await validateQueueItems({
    items,
    schema,
    config: target.config,
    root: target.root,
    store: target.storePath,
  });
  return { items, validation };
};

const ensureQueueValid = ({
  errors,
  contractError,
}: {
  errors: Array<{ id: string; message: string }>;
  contractError: boolean;
}): void => {
  if (!errors.length) return;
  const error = new Error("Queue validation failed.");
  (error as Error & { code?: number; details?: unknown }).code = contractError
    ? 6
    : 3;
  (error as Error & { details?: unknown }).details = { errors };
  throw error;
};

const findItem = (
  items: QueueItem[],
  id: string,
): { index: number; item: QueueItem } => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`Unknown ID: ${id}`);
  }
  const item = items[index];
  if (!item) {
    throw new Error(`Queue item missing at index ${index}.`);
  }
  return { index, item };
};

const assertTransition = (item: QueueItem, nextStatus: QueueStatus): string | null => {
  const allowed = new Set([
    ...(item.status === "queued" ? ["active", "blocked", "dropped"] : []),
    ...(item.status === "active" ? ["blocked", "done", "dropped"] : []),
    ...(item.status === "blocked" ? ["queued", "active", "dropped"] : []),
  ]);
  if (!allowed.has(nextStatus)) {
    return `Invalid transition ${item.status} -> ${nextStatus}`;
  }
  return null;
};

const maybeDraftLesson = async ({
  store,
  queueId,
  failure,
}: {
  store: string;
  queueId: string | null;
  failure: { command: string; exitCode: number } | null;
}): Promise<LessonItem | null> => {
  if (!failure) return null;
  const signature = `${failure.command}:${failure.exitCode}`;
  const now = Date.now();
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;

  const runLog = await readJsonl<RunLogEntry>(
    path.join(store, "runs", "runs.jsonl"),
  );
  const failures = runLog
    .map((record) => record.item)
    .filter((entry) => entry.kind === "gate_run")
    .filter((entry) => {
      const ts = Date.parse(entry.ts ?? "");
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .flatMap((entry) => entry.commands ?? [])
    .filter((command) => command.exitCode !== 0)
    .filter((command) => `${command.cmd}:${command.exitCode}` === signature);

  const count = failures.length + 1;
  if (count < 3) return null;

  const lessons = await readLessonItems(store);
  const existing = lessons.find((lesson) => lesson.rule === signature);
  if (existing) return existing;

  const lesson = normalizeLessonInput({
    input: {
      id: nextLessonId(lessons),
      tool: "gate",
      rule: signature,
      pattern: `Repeated gate failure: ${failure.command}`,
      prevention:
        "Review the failing gate output and add a prevention step or test.",
      frequency: count,
      last_seen: new Date().toISOString(),
      queue_refs: queueId ? [queueId] : [],
    },
    fallbackId: nextLessonId(lessons),
  });

  const validation = await validateLessonItem(lesson);
  if (!validation.ok) return null;

  lessons.push(lesson);
  await writeLessonItems(store, lessons);
  return lesson;
};

const hasGitDir = (repoRoot: string): boolean =>
  existsSync(path.join(repoRoot, ".git"));

const readGitHead = (repoRoot: string): string | null => {
  if (!hasGitDir(repoRoot)) return null;
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const head = String(result.stdout ?? "").trim();
  return head || null;
};

const readGitRemote = (repoRoot: string): string | null => {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const remote = String(result.stdout ?? "").trim();
  return remote || null;
};

const resolveOriginSubpath = (repoRoot: string, cwd: string | null): string | null => {
  if (!cwd) return null;
  const relative = path.relative(repoRoot, path.resolve(cwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
};

const buildOrigin = ({
  repoRoot,
  cwd,
}: {
  repoRoot: string;
  cwd: string | null;
}): QueueOrigin | null => {
  const commit = readGitHead(repoRoot);
  if (!commit) return null;
  const repoRemote = readGitRemote(repoRoot);
  const origin: QueueOrigin = { commit };
  if (repoRemote) {
    origin.repo_remote = repoRemote;
  } else {
    origin.repo_path = repoRoot;
  }
  const subpath = resolveOriginSubpath(repoRoot, cwd);
  if (subpath) origin.subpath = subpath;
  return origin;
};

const resolveProducerTarget = async (cwd: string): Promise<TargetContext | null> => {
  try {
    const { target } = await resolveTarget({
      cwd,
      selection: null,
      storeSelection: process.env["ATO_STORE"] ?? null,
      requireWrite: false,
    });
    return target;
  } catch {
    return null;
  }
};

const resolveCrossRepoOrigin = async (
  target: TargetContext,
): Promise<QueueOrigin | null> => {
  const sourceTarget = await resolveProducerTarget(process.cwd());
  if (!sourceTarget) return null;
  const sourceRoot = path.resolve(sourceTarget.root);
  const targetRoot = path.resolve(target.root);
  if (sourceRoot === targetRoot) return null;
  return buildOrigin({ repoRoot: sourceRoot, cwd: process.cwd() });
};

const applyOriginIfMissing = (
  item: QueueItem,
  origin: QueueOrigin | null,
): QueueItem => {
  if (!origin || item.origin) return item;
  return { ...item, origin };
};

const normalizeCommand = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .trim();

const extractCommand = (value: string): { command: string | null; note: string | null } => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("cmd:")) return { command: null, note: null };
  const raw = trimmed.slice("cmd:".length).trim();
  const noteMatch = raw.match(/\(([^)]+)\)\s*$/);
  const note = noteMatch ? noteMatch[1]?.trim() ?? null : null;
  const command = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return { command: command || null, note };
};

const isGateRunCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command).toLowerCase();
  return normalized.includes("gate run") && normalized.includes("--mode") && normalized.includes("full");
};

const isCycleStartCommand = (command: string): boolean =>
  normalizeCommand(command).toLowerCase().includes(" cycle start");

const isCycleFinishCommand = (command: string): boolean =>
  normalizeCommand(command).toLowerCase().includes(" cycle finish");

const isPackVerifyCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command).toLowerCase();
  return normalized.includes("pack verify");
};

const isExpectedRefusal = (note: string | null): boolean =>
  Boolean(note && note.toLowerCase().includes("expect refusal"));

const runCommand = async ({
  cmd,
  cwd,
  env,
}: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number }> =>
  new Promise((resolve) => {
    const [bin, ...args] = cmd;
    if (!bin) {
      resolve({ ok: false, exitCode: 1, stdout: "", stderr: "Missing command.", durationMs: 0 });
      return;
    }
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code: number | null) => {
      const durationMs = Date.now() - started;
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs,
      });
    });
  });

const writeLogFile = async (filePath: string, payload: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
};

const ABSOLUTE_WINDOWS_TOKEN_RE = /[A-Za-z]:\\[^\s"'<>[\]{}()]+/g;
const ABSOLUTE_UNIX_TOKEN_RE = /\/(?:[^\s"'<>[\]{}()]+\/?)+/g;

const sanitizeAcceptanceText = (value: string, root: string): string =>
  value
    .replace(ABSOLUTE_WINDOWS_TOKEN_RE, (token) =>
      normalizeArtifactPath(root, token),
    )
    .replace(ABSOLUTE_UNIX_TOKEN_RE, (token) => normalizeArtifactPath(root, token));

const sanitizeAcceptanceArtifact = async (
  filePath: string,
  root: string,
): Promise<void> => {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  const isJson = filePath.endsWith(".json");
  let next = raw;
  if (isJson) {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      const sanitized = redactAbsolutePaths(parsed, root);
      next = `${JSON.stringify(sanitized, null, 2)}\n`;
    } catch {
      const sanitizedText = sanitizeAcceptanceText(raw, root);
      next = sanitizedText.endsWith("\n") ? sanitizedText : `${sanitizedText}\n`;
    }
  } else {
    const sanitizedText = sanitizeAcceptanceText(raw, root);
    next = sanitizedText.endsWith("\n") ? sanitizedText : `${sanitizedText}\n`;
  }

  if (next !== raw) {
    await writeLogFile(filePath, next);
  }
};

const EVIDENCE_PATH_RE = /\b[\w./-]+\.[\w.-]+(?::\d+(?::\d+)?)?\b/;
const EVIDENCE_CMD_RE = /\b(?:cmd|output|log):\S+/i;
const SENSITIVE_DOTFILE_RE = /^\.env(?:[._-].*)?$/i;

const evaluateInputCitation = (
  value: string,
): { matched: boolean; valid: boolean } => {
  const trimmed = value.trim();
  const citation = parseInputCitation(trimmed);
  if (!citation) {
    return { matched: false, valid: false };
  }
  if (
    citationPrefixCarriesPath(citation.prefix) &&
    isAbsoluteCitationPath(citation.remainder)
  ) {
    return { matched: true, valid: false };
  }
  if (citation.prefix === "file") {
    const citedPath = citation.remainder;
    if (SENSITIVE_DOTFILE_RE.test(citedPath)) {
      return { matched: true, valid: false };
    }
    return { matched: true, valid: true };
  }
  return { matched: true, valid: true };
};

const hasValidInputCitation = (value: string): boolean =>
  evaluateInputCitation(value).valid;

const hasEvidenceCitation = (value: string): boolean => {
  const trimmed = value.trim();
  const citation = evaluateInputCitation(trimmed);
  if (citation.matched) return citation.valid;
  return EVIDENCE_PATH_RE.test(trimmed) || EVIDENCE_CMD_RE.test(trimmed);
};

const normalizeEvidenceEntry = (root: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const prefixMatch = trimmed.match(/^(file|cmd|log|output|note):(.+)$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    const rawPath = prefixMatch[2]?.trim() ?? "";
    if (!rawPath) return "";
    if (path.isAbsolute(rawPath)) {
      return `${prefix}:${toRelativePath(root, rawPath)}`;
    }
    return `${prefix}:${rawPath}`;
  }
  if (path.isAbsolute(trimmed)) {
    return `file:${toRelativePath(root, trimmed)}`;
  }
  return `file:${trimmed}`;
};

const buildEvidenceNoteLine = (
  root: string,
  cycleId: string,
  entries: string[],
): string | null => {
  const normalized = entries
    .map((entry) => normalizeEvidenceEntry(root, String(entry)))
    .filter(Boolean);
  if (!normalized.length) return null;
  const unique = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  return `Completed in cycle ${cycleId}. Evidence: ${unique.join(" ")}`;
};

const dedupeStable = (entries: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    output.push(entry);
  }
  return output;
};

const buildAcceptanceArtifact = (cycleDir: string, index: number, command: string): string => {
  const padded = String(index).padStart(2, "0");
  const suffix = command.includes("--json") ? "json" : "log";
  return path.join(cycleDir, `acceptance-${padded}.${suffix}`);
};

const findExistingAcceptanceArtifact = async (
  cycleDir: string,
  index: number,
): Promise<string | null> => {
  const padded = String(index).padStart(2, "0");
  const jsonPath = path.join(cycleDir, `acceptance-${padded}.json`);
  const logPath = path.join(cycleDir, `acceptance-${padded}.log`);
  try {
    await fs.access(jsonPath);
    return jsonPath;
  } catch {
    // ignore
  }
  try {
    await fs.access(logPath);
    return logPath;
  } catch {
    return null;
  }
};

const updateAuditFromFile = async (
  entry: AcceptanceAuditEntry,
  filePath: string,
  exitCode: number | null,
): Promise<void> => {
  entry.exit_code = exitCode;
  entry.sha256_of_stdout = await hashFileSha256(filePath);
  entry.sha256_of_stderr = null;
};

const updateAuditFromResult = (
  entry: AcceptanceAuditEntry,
  result: { exitCode: number; stdout: string; stderr: string },
): void => {
  entry.exit_code = result.exitCode;
  entry.sha256_of_stdout = hashStringSha256(result.stdout);
  entry.sha256_of_stderr = hashStringSha256(result.stderr);
};

const writeAcceptanceAudit = async (
  cycleDir: string,
  entries: AcceptanceAuditEntry[],
): Promise<string> => {
  const filePath = path.join(cycleDir, "acceptance-audit.jsonl");
  const output = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeLogFile(filePath, output.length ? `${output}\n` : "");
  return filePath;
};

const startQueueItem = async ({
  target,
  queueId,
  pluginsEnabled,
}: {
  target: TargetContext;
  queueId: string;
  pluginsEnabled: boolean;
}): Promise<void> => {
  const { items, validation } = await loadQueueForWrite(target);
  ensureQueueValid(validation);
  const origin = await resolveCrossRepoOrigin(target);
  const found = findItem(items, queueId);
  const transitionError = assertTransition(found.item, "active");
  if (transitionError) throw new Error(transitionError);

  await runPluginHooks({
    target,
    hook: "queue.pre",
    enabled: pluginsEnabled,
    payload: {
      hook: "queue.pre",
      action: "start",
      queueId,
      status: { from: found.item.status, to: "active" },
      target: { id: target.id, root: target.root },
    },
  });

  items[found.index] = applyOriginIfMissing(
    {
      ...found.item,
      status: "active",
      updated_at: new Date().toISOString(),
    },
    origin,
  );
  await writeQueueItems(target.storePath, items);
  await writeViews(target.storePath, items);

  const state = await readState(target.storePath);
  await writeState(target.storePath, {
    ...state,
    version: state.version ?? 1,
    targetId: target.id,
    activeQueueId: queueId,
  });

  await appendRunLog(target.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_transition",
    target_id: target.id,
    queue_id: queueId,
    commands: [],
    artifacts: [],
    summary: "queue start",
  });

  await runPluginHooks({
    target,
    hook: "queue.post",
    enabled: pluginsEnabled,
    payload: {
      hook: "queue.post",
      action: "start",
      queueId,
      status: { from: found.item.status, to: "active" },
      target: { id: target.id, root: target.root },
    },
  });
};

const addEvidenceInputs = async ({
  target,
  queueId,
  entries,
}: {
  target: TargetContext;
  queueId: string;
  entries: string[];
}): Promise<{ added: number; total: number }> => {
  const { items, validation } = await loadQueueForWrite(target);
  ensureQueueValid(validation);
  const origin = await resolveCrossRepoOrigin(target);
  const found = findItem(items, queueId);
  const spec = found.item.spec;
  if (!spec || typeof spec !== "object") {
    throw new Error(`Queue item '${queueId}' is missing a spec payload.`);
  }

  const existingInputs = Array.isArray(spec.inputs)
    ? spec.inputs.map((entry) => String(entry))
    : [];
  const normalizedExisting = existingInputs
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedEntries = entries.map((entry) => entry.trim()).filter(Boolean);
  const nextInputs = dedupeStable([...normalizedExisting, ...normalizedEntries]);
  const added = nextInputs.length - normalizedExisting.length;
  const unchanged =
    nextInputs.length === existingInputs.length &&
    nextInputs.every((entry, index) => entry === existingInputs[index]);

  if (unchanged) {
    return { added: 0, total: nextInputs.length };
  }

  const updated = applyOriginIfMissing(
    {
      ...found.item,
      spec: {
        ...spec,
        inputs: nextInputs,
      },
      updated_at: new Date().toISOString(),
    },
    origin,
  );

  items[found.index] = updated;
  const schema = await loadQueueSchema();
  const nextValidation = await validateQueueItems({
    items,
    schema,
    config: target.config,
    root: target.root,
    store: target.storePath,
  });
  ensureQueueValid(nextValidation);

  await writeQueueItems(target.storePath, items);
  await writeViews(target.storePath, items);

  await appendRunLog(target.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_update",
    target_id: target.id,
    queue_id: queueId,
    commands: [],
    artifacts: [],
    summary: "queue evidence add",
  });

  return { added, total: nextInputs.length };
};

const previewEvidenceInputs = async ({
  target,
  queueId,
  entries,
}: {
  target: TargetContext;
  queueId: string;
  entries: string[];
}): Promise<{ added: number; total: number }> => {
  const { items, validation } = await loadQueueForWrite(target);
  ensureQueueValid(validation);
  const found = findItem(items, queueId);
  const spec = found.item.spec;
  if (!spec || typeof spec !== "object") {
    throw new Error(`Queue item '${queueId}' is missing a spec payload.`);
  }

  const existingInputs = Array.isArray(spec.inputs)
    ? spec.inputs.map((entry) => String(entry))
    : [];
  const normalizedExisting = existingInputs
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedEntries = entries.map((entry) => entry.trim()).filter(Boolean);
  const nextInputs = dedupeStable([...normalizedExisting, ...normalizedEntries]);
  const added = nextInputs.length - normalizedExisting.length;

  return { added, total: nextInputs.length };
};

const appendCompletionEvidenceNote = ({
  root,
  cycleId,
  item,
  evidence,
}: {
  root: string;
  cycleId: string;
  item: QueueItem;
  evidence: string[];
}): { item: QueueItem; added: boolean } => {
  const status = collectCompletionEvidenceStatus(item);
  if (status.missingInputs.length > 0 || status.summaryHasEvidence) {
    return { item, added: false };
  }
  const noteLine = buildEvidenceNoteLine(root, cycleId, evidence);
  if (!noteLine) {
    return { item, added: false };
  }
  const notes = typeof item.notes === "string" ? item.notes.trim() : "";
  if (notes.includes(noteLine)) {
    return { item, added: false };
  }
  const nextNotes = notes ? `${notes}\n${noteLine}` : noteLine;
  return {
    item: {
      ...item,
      notes: nextNotes,
      updated_at: new Date().toISOString(),
    },
    added: true,
  };
};

const collectCompletionEvidenceStatus = (item: QueueItem) => {
  const inputs = item.spec?.inputs ?? [];
  const missingInputs: string[] = [];
  const missingInputPaths: string[] = [];
  inputs.forEach((entry, index) => {
    if (!hasValidInputCitation(entry)) {
      missingInputs.push(entry);
      missingInputPaths.push(`/spec/inputs/${index}`);
    }
  });
  const notes = typeof item.notes === "string" ? item.notes.trim() : "";
  const planRationale =
    typeof item.spec?.plan?.rationale === "string"
      ? item.spec.plan.rationale.trim()
      : "";
  const summary = [notes, planRationale].filter(Boolean).join(" ");
  const summaryHasEvidence = summary ? hasEvidenceCitation(summary) : false;
  return {
    missingInputs,
    missingInputPaths,
    notes,
    planRationale,
    summary,
    summaryHasEvidence,
  };
};

const ensureQueueCompletionEvidence = (item: QueueItem): void => {
  const status = collectCompletionEvidenceStatus(item);
  if (status.missingInputs.length) {
    const error = new Error(
      "Queue item inputs must include evidence citations before completion.",
    );
    (error as Error & { code?: number; details?: unknown }).code = 3;
    (error as Error & { details?: unknown }).details = {
      missing_input_paths: status.missingInputPaths,
      missing_inputs: status.missingInputs,
      template: [
        {
          spec: {
            inputs: ["output:/path/to/evidence"],
          },
        },
      ],
      guidance: [
        `Include ${INPUT_CITATION_PREFIX_MESSAGE} references in spec.inputs.`,
      ],
    };
    throw error;
  }
  if (!status.summary || !status.summaryHasEvidence) {
    const missingEvidencePaths = [];
    if (!status.notes || !hasEvidenceCitation(status.notes)) {
      missingEvidencePaths.push("/notes");
    }
    if (!status.planRationale || !hasEvidenceCitation(status.planRationale)) {
      missingEvidencePaths.push("/spec/plan/rationale");
    }
    const error = new Error(
      "Completion summary evidence is required before completing the queue item.",
    );
    (error as Error & { code?: number; details?: unknown }).code = 3;
    (error as Error & { details?: unknown }).details = {
      missing_evidence_paths: missingEvidencePaths,
      summary: status.summary || null,
      summary_has_evidence: status.summaryHasEvidence,
      template: [
        {
          notes: "Summary... Evidence: output:/path/to/evidence",
        },
        {
          spec: {
            plan: {
              rationale: "Summary... Evidence: output:/path/to/evidence",
            },
          },
        },
      ],
      guidance: [
        "Add a completion summary with evidence in notes or spec.plan.rationale.",
      ],
    };
    throw error;
  }
};

type FinishPreflightIssue = {
  code: string;
  path: string | null;
  message: string;
  suggested_commands: string[];
};

const pushFinishPreflightIssue = (
  issues: FinishPreflightIssue[],
  issue: FinishPreflightIssue,
): void => {
  issues.push({
    ...issue,
    suggested_commands: [...issue.suggested_commands].sort((a, b) =>
      a.localeCompare(b),
    ),
  });
};

const sortFinishPreflightIssues = (
  issues: FinishPreflightIssue[],
): FinishPreflightIssue[] =>
  [...issues].sort((a, b) => {
    const codeDiff = a.code.localeCompare(b.code);
    if (codeDiff !== 0) return codeDiff;
    const pathA = a.path ?? "";
    const pathB = b.path ?? "";
    const pathDiff = pathA.localeCompare(pathB);
    if (pathDiff !== 0) return pathDiff;
    return a.message.localeCompare(b.message);
  });

const runCycleFinishPreflight = async ({
  target,
  json,
}: {
  target: TargetContext;
  json: boolean;
}): Promise<void> => {
  const issues: FinishPreflightIssue[] = [];
  const state = await readState(target.storePath);
  const activeCycleId = (state as typeof state & { activeCycleId?: string })
    .activeCycleId;
  const activeQueueId = (state as typeof state & { activeCycleQueueId?: string })
    .activeCycleQueueId;
  if (!activeCycleId) {
    pushFinishPreflightIssue(issues, {
      code: "NO_ACTIVE_CYCLE",
      path: toRelativePath(target.root, path.join(target.storePath, "state.json")),
      message: "No active cycle state found.",
      suggested_commands: ["ato cycle start --json"],
    });
  }

  const cycleDir = activeCycleId
    ? path.join(target.storePath, "cycles", activeCycleId)
    : null;
  const cycleStatePath = cycleDir ? path.join(cycleDir, "cycle-state.json") : null;
  const cycleState = cycleStatePath
    ? await readJson<Record<string, unknown> | null>(cycleStatePath, null)
    : null;
  if (activeCycleId && !cycleState) {
    pushFinishPreflightIssue(issues, {
      code: "MISSING_CYCLE_STATE",
      path: cycleStatePath ? toRelativePath(target.root, cycleStatePath) : null,
      message: "Missing cycle-state.json for active cycle.",
      suggested_commands: [
        "ato cycle abort --reason \"missing cycle-state artifact\" --json",
        "ato cycle start --json",
      ],
    });
  }

  const queueId =
    (cycleState && typeof cycleState["queue_id"] === "string"
      ? cycleState["queue_id"]
      : null) ??
    activeQueueId ??
    null;
  if (activeCycleId && !queueId) {
    pushFinishPreflightIssue(issues, {
      code: "MISSING_QUEUE_ID",
      path: cycleStatePath ? toRelativePath(target.root, cycleStatePath) : null,
      message: "Active cycle is missing queue_id.",
      suggested_commands: ["ato cycle abort --reason \"active cycle missing queue id\" --json"],
    });
  }

  if (cycleState) {
    const contractIndexRel =
      typeof cycleState["contract_index_ref"] === "string"
        ? String(cycleState["contract_index_ref"])
        : toRelativePath(
            target.root,
            path.join(cycleDir ?? target.storePath, "contract-index.json"),
          );
    const contractExtractRel =
      typeof cycleState["contract_extract_ref"] === "string"
        ? String(cycleState["contract_extract_ref"])
        : toRelativePath(
            target.root,
            path.join(cycleDir ?? target.storePath, "contract-extract.json"),
          );
    const contractArtifacts = [
      { code: "MISSING_CONTRACT_INDEX", rel: contractIndexRel },
      { code: "MISSING_CONTRACT_EXTRACT", rel: contractExtractRel },
    ];
    for (const artifact of contractArtifacts) {
      if (!artifact.rel) continue;
      const resolved = path.resolve(target.root, artifact.rel);
      try {
        await fs.access(resolved);
      } catch {
        pushFinishPreflightIssue(issues, {
          code: artifact.code,
          path: artifact.rel,
          message: `Missing required contract artifact: ${artifact.rel}.`,
          suggested_commands: ["ato cycle start --json"],
        });
      }
    }
  }

  const { items, validation } = await loadQueueForWrite(target);
  if (validation.errors.length) {
    for (const error of [...validation.errors].sort((a, b) =>
      `${a.id}:${a.message}`.localeCompare(`${b.id}:${b.message}`),
    )) {
      pushFinishPreflightIssue(issues, {
        code: "QUEUE_VALIDATION_ERROR",
        path: null,
        message: `${error.id}: ${error.message}`,
        suggested_commands: ["ato q validate --json"],
      });
    }
  }

  const queueItem = queueId
    ? items.find((item) => item.id === queueId) ?? null
    : null;
  if (queueId && !queueItem) {
    pushFinishPreflightIssue(issues, {
        code: "MISSING_QUEUE_ITEM",
        path: ".ato/queue/items.jsonl",
        message: `Queue item ${queueId} not found in queue store.`,
        suggested_commands: [
          "ato q list --json",
          "ato cycle abort --reason \"queue item missing for active cycle\" --json",
        ],
      });
  }

  if (queueItem) {
    if (queueItem.status !== "active") {
      pushFinishPreflightIssue(issues, {
        code: "QUEUE_NOT_ACTIVE",
        path: ".ato/queue/items.jsonl",
        message: `Queue item ${queueItem.id} must be active before cycle finish.`,
        suggested_commands: [
          "ato q list --json",
          `ato cycle abort --reason "queue ${queueItem.id} is not active" --json`,
        ],
      });
    }

    const contractRefs = Array.isArray(queueItem.spec?.contract_refs)
      ? queueItem.spec?.contract_refs ?? []
      : [];
    if (!contractRefs.length) {
      pushFinishPreflightIssue(issues, {
        code: "MISSING_CONTRACT_REFS",
        path: "/spec/contract_refs",
        message: "Queue item must define spec.contract_refs before finish.",
        suggested_commands: ["ato q validate --json"],
      });
    }

    const inputs = Array.isArray(queueItem.spec?.inputs)
      ? queueItem.spec.inputs.map((entry) => String(entry))
      : [];
    if (!inputs.length) {
      pushFinishPreflightIssue(issues, {
        code: "MISSING_INPUTS",
        path: "/spec/inputs",
        message: "Queue item must define spec.inputs before finish.",
        suggested_commands: ["ato q validate --json"],
      });
    }
    for (let index = 0; index < inputs.length; index += 1) {
      const entry = String(inputs[index] ?? "");
      const pathHint = `/spec/inputs/${index}`;
      if (!hasValidInputCitation(entry)) {
        pushFinishPreflightIssue(issues, {
          code: "INVALID_INPUT_CITATION",
          path: pathHint,
          message: `Input '${entry}' is not a valid evidence citation.`,
          suggested_commands: ["ato q validate --json"],
        });
        continue;
      }
      const fileMatch = entry.match(/^file:(.+)$/i);
      if (!fileMatch) continue;
      const citedPath = (fileMatch[1] ?? "").trim();
      if (!citedPath) continue;
      const resolvedPath = path.resolve(target.root, citedPath);
      try {
        const stat = await fs.stat(resolvedPath);
        if (stat.isDirectory()) {
          pushFinishPreflightIssue(issues, {
            code: "INPUT_FILE_IS_DIRECTORY",
            path: pathHint,
            message: `Input '${entry}' points to a directory, not a file.`,
            suggested_commands: ["ato q validate --json"],
          });
        }
      } catch {
        pushFinishPreflightIssue(issues, {
          code: "INPUT_FILE_MISSING",
          path: pathHint,
          message: `Input '${entry}' points to a missing file.`,
          suggested_commands: ["ato q validate --json"],
        });
      }
    }

    const acceptance = Array.isArray(queueItem.spec?.acceptance_criteria)
      ? queueItem.spec.acceptance_criteria.map((entry) => String(entry).trim())
      : [];
    if (!acceptance.length) {
      pushFinishPreflightIssue(issues, {
        code: "MISSING_ACCEPTANCE_CRITERIA",
        path: "/spec/acceptance_criteria",
        message: "Queue item must define acceptance criteria before finish.",
        suggested_commands: ["ato q validate --json"],
      });
    } else {
      const hasFinishAcceptance = acceptance.some((entry) => {
        const { command } = extractCommand(entry);
        return Boolean(command && isCycleFinishCommand(command));
      });
      if (!hasFinishAcceptance) {
        pushFinishPreflightIssue(issues, {
          code: "MISSING_CYCLE_FINISH_ACCEPTANCE",
          path: "/spec/acceptance_criteria",
          message:
            "Acceptance criteria must include a cycle finish command entry.",
          suggested_commands: [
            `ato q update ${queueItem.id} --acceptance-add "cmd:ato cycle finish --json"`,
            "ato q validate --json",
          ],
        });
      }
    }
  }

  const sortedIssues = sortFinishPreflightIssues(issues);
  const suggestedNextCommands = sortedIssues.length
    ? dedupeStable(
        sortedIssues.flatMap((issue) => issue.suggested_commands),
      ).sort((a, b) => a.localeCompare(b))
    : [
        "ato cycle finish --json --run-acceptance --run-gate --run-pack-verify --budget-ms 600000",
      ];
  const payload = {
    ok: sortedIssues.length === 0,
    schema_version: CYCLE_FINISH_PREFLIGHT_SCHEMA,
    cycle_id: activeCycleId ?? null,
    queue_id: queueId,
    issues: sortedIssues,
    suggested_next_commands: suggestedNextCommands,
  };

  if (json) {
    writeJson(payload);
  } else {
    const lines = [
      formatTargetLine(target),
      `cycle preflight-finish: ${payload.ok ? "ok" : "issues"}`,
      `cycle: ${payload.cycle_id ?? "none"}`,
      `queue: ${payload.queue_id ?? "none"}`,
      `issues: ${sortedIssues.length}`,
    ];
    for (const issue of sortedIssues) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
    if (suggestedNextCommands.length) {
      lines.push("suggested commands:");
      for (const command of suggestedNextCommands) {
        lines.push(`- ${command}`);
      }
    }
    writeLines(lines);
  }
};

export const runCycleCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (
    !subcommand ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    flags["help"]
  ) {
    writeLines([HELP]);
    return;
  }

  if (flags["allow-dirty"] || flags["allowDirty"]) {
    const error = new Error("Unknown option: --allow-dirty");
    (error as Error & { code?: number }).code = 1;
    throw error;
  }

  const checkOnly = isFlagEnabled(flags["check-only"]) || isFlagEnabled(flags["checkOnly"]);
  if (subcommand === "preflight-finish" || (subcommand === "finish" && checkOnly)) {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    await runCycleFinishPreflight({ target, json });
    return;
  }

  if (subcommand === "start") {
    let target: TargetContext;
    try {
      target = await resolveTargetContext({ context, requireWrite: true });
    } catch (error) {
      const targetError = error instanceof TargetError ? error : null;
      const notInitialized =
        targetError?.code === "ATO_NOT_INITIALIZED" ||
        (typeof targetError?.details === "object" &&
          targetError?.details !== null &&
          (targetError.details as { code?: string }).code === "ATO_NOT_INITIALIZED");
      if (notInitialized) {
        const suggestedFix = ["ato init --json"];
        if (json) {
          writeJson({
            ok: false,
            code: "ATO_NOT_INITIALIZED",
            suggested_fix: suggestedFix,
          });
        } else {
          writeLines([
            "error: ATO is not initialized for this repo.",
            "suggested fix:",
            ...suggestedFix.map((line) => `- ${line}`),
          ]);
        }
        process.exitCode = 3;
        return;
      }
      throw error;
    }
    await ensureProtocol(target.root);

    const gitStatus = await gatherGitStatus(target.root);
    if (gitStatus.dirty) {
      const message =
        "Clean working tree (commit/stash/restore) before cycle start.";
      const suggestedFix = [
        "Commit the current changes.",
        "Stash changes (git stash) and re-run ato cycle start --json.",
        "Discard changes (git restore .) and re-run ato cycle start --json.",
      ];
      if (json) {
        writeJson({
          ok: false,
          code: "DIRTY_TREE",
          error: {
            message,
            details: {
              dirty_paths: gitStatus.dirty_paths ?? [],
              suggested_fix: suggestedFix,
            },
          },
          dirty_paths: gitStatus.dirty_paths ?? [],
          suggested_fix: suggestedFix,
        });
      } else {
        writeLines([
          `error: ${message}`,
          gitStatus.status_sb,
          `dirty paths: ${(gitStatus.dirty_paths ?? []).join(", ")}`,
          "suggested fix:",
          ...suggestedFix.map((line) => `- ${line}`),
        ]);
      }
      process.exitCode = 3;
      return;
    }

    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const blockState = await resolveBlockState(target.storePath);
      const hasBlocks = blockState.block_ids.length > 0;
      const activeBlockId = blockState.active_block_id;
      if (hasBlocks && !activeBlockId) {
        const error = new Error("No active block available for cycle start.");
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          next_block_id: blockState.next_block_id,
          guidance: [
            `Open next block ${blockState.next_block_id}.`,
            "Re-run: ato cycle start --json",
          ],
        };
        throw error;
      }

      const block = activeBlockId
        ? await loadBlockConfig(target.storePath, activeBlockId)
        : null;
      const configuredBlockId = resolveBlockId(block) ?? activeBlockId ?? null;
      const baselineTag = resolveBaselineTag(block);
      const blockFrozen = isBlockFrozen(block);
      if (configuredBlockId) {
        if (!baselineTag) {
          const error = new Error(
            `Block ${configuredBlockId} is missing a baseline tag.`,
          );
          (error as Error & { code?: number; details?: unknown }).code = 3;
          (error as Error & { details?: unknown }).details = {
            block_id: configuredBlockId,
            guidance: [
              "Register a baseline tag in the block config.",
              "Create a baseline registry entry under .ato/meta/baselines.",
            ],
          };
          throw error;
        }

        const baselineCheck = await verifyBaselineRegistry({
          root: target.root,
          store: target.storePath,
          tag: baselineTag,
        });
        if (!baselineCheck.ok) {
          const error = new Error("Baseline integrity check failed.");
          (error as Error & { code?: number; details?: unknown }).code = 3;
          (error as Error & { details?: unknown }).details = baselineCheck;
          throw error;
        }

        if (blockFrozen) {
          const records = await readCycleRecords(target.storePath);
          const lastDone = findLastDoneCycle(records, configuredBlockId);
          const priorCheck = await verifyPriorGateArtifacts({
            root: target.root,
            record: lastDone,
          });
          if (!priorCheck.ok) {
            const error = new Error(
              "Prior gate artifacts are missing or mismatched for this block.",
            );
            (error as Error & { code?: number; details?: unknown }).code = 3;
            (error as Error & { details?: unknown }).details = {
              block_id: configuredBlockId,
              last_cycle_id: lastDone?.id ?? null,
              missing: priorCheck.missing,
              mismatched: priorCheck.mismatched,
              guidance: [
                "Restore the missing artifacts or re-run the full gate for the prior cycle.",
                "Avoid deleting or rewriting gate artifacts during a frozen block.",
              ],
            };
            throw error;
          }
        }
      }

      const preflight = await captureCyclePreflight({
        root: target.root,
        store: target.storePath,
        targetId: target.id,
      });

      let selection: CycleSelection;
      try {
        selection = await selectCycleQueueItem({
          store: target.storePath,
          targetId: target.id,
          blockId: configuredBlockId,
          cycleId: preflight.cycle_id,
          cycleIndex: preflight.cycle_index,
        });
      } catch (error) {
        const err = error as Error & { code?: number; details?: unknown };
        if (err.code === 3 && err.details && typeof err.details === "object") {
          const details = err.details as Record<string, unknown>;
          const blockLabel =
            typeof details["block_id"] === "string"
              ? details["block_id"]
              : blockState.active_block_id ?? blockState.next_block_id;
          const suggestedFix = [
            buildSelectionFailureGuidance(blockLabel),
            "Re-run: ato cycle start --json",
          ];
          if (json) {
            writeJson({
              ok: false,
              code: err.code ?? 3,
              error: { message: err.message, details: err.details },
              suggested_fix: suggestedFix,
            });
          } else {
            writeLines([
              `error: ${err.message ?? "No eligible cycle candidates."}`,
              "suggested fix:",
              ...suggestedFix.map((line) => `- ${line}`),
            ]);
          }
          process.exitCode = 3;
          return;
        }
        throw error;
      }
      const selectedId = selection.selection?.queue_id;
      if (!selectedId) {
        const error = new Error("Selection missing selected_id.");
        (error as Error & { code?: number }).code = 3;
        throw error;
      }

      const queueRecords = await readQueueItems(target.storePath);
      const queueItems = queueRecords.map((record) => record.item);
      const selectedItem = queueItems.find((item) => item.id === selectedId);
      if (!selectedItem) {
        throw new Error(`Queue item ${selectedId} not found.`);
      }

      const resolvedBlockId =
        selection.seed?.block_id ??
        inferBlockIdFromTitle(selectedItem.title) ??
        configuredBlockId ??
        null;

      const { contractIndexRel, contractExtractRel } = await ensureContractArtifacts({
        target,
        cycleId: preflight.cycle_id,
        queueItem: selectedItem,
      });

      const cycleDir = path.join(target.storePath, "cycles", preflight.cycle_id);

      const { items: startItems, validation: startValidation } =
        await loadQueueForWrite(target);
      ensureQueueValid(startValidation);
      const startFound = findItem(startItems, selectedId);
      if (startFound.item.status !== "active") {
        await startQueueItem({
          target,
          queueId: selectedId,
          pluginsEnabled: context.pluginsEnabled,
        });
      }

      const selectionEvidence = buildCycleSelectionEvidence({
        selection,
      });
      const selectionPath = path.join(cycleDir, "selection.json");
      const selectionPayload = {
        schema_version: CYCLE_SELECTION_SCHEMA,
        selection,
        selection_evidence: selectionEvidence,
      };
      await writeJsonFile(selectionPath, selectionPayload);
      const selectionRel = toRelativePath(target.root, selectionPath);

      const cycleStatePath = path.join(cycleDir, "cycle-state.json");
      const startedAt = new Date().toISOString();
      const cycleState = {
        schema_version: CYCLE_STATE_SCHEMA,
        cycle_id: preflight.cycle_id,
        queue_id: selectedId,
        started_at: startedAt,
        block_id: resolvedBlockId,
        selection_mode: "queue",
        selection_hash: selection.selection?.hash ?? null,
        preflight: {
          path: preflight.path,
          sha256: preflight.sha256,
        },
        selection_path: toRelativePath(target.root, selectionPath),
        contract_index_ref: contractIndexRel,
        contract_extract_ref: contractExtractRel,
      };
      await writeJsonFile(cycleStatePath, cycleState);

      const agentInstructions = [
        `Review contract extracts: ${contractExtractRel}`,
        `Review selection/preflight: ${selectionRel}, ${preflight.path}`,
        "Review the queue item spec (problem/outcome/plan/deliverables/acceptance).",
        `Implement queue item ${selectedId}.`,
        "Run acceptance checks.",
        "Run: ato cycle finish --json",
      ];

      const state = await readState(target.storePath);
      await writeState(target.storePath, {
        ...state,
        version: state.version ?? 1,
        targetId: target.id,
        activeCycleId: preflight.cycle_id,
        activeCycleQueueId: selectedId,
        activeCycleStartedAt: startedAt,
      } as typeof state);

      const payload = {
        ok: true,
        schema_version: CYCLE_START_SCHEMA,
        cycle_id: preflight.cycle_id,
        queue_id: selectedId,
        paths_written: [
          toRelativePath(target.root, path.join(cycleDir, "preflight.json")),
          selectionRel,
          toRelativePath(target.root, cycleStatePath),
          contractIndexRel,
          contractExtractRel,
        ],
        next_required_actions: [
          "Implement the queue item and run acceptance checks.",
          "Run: ato cycle finish --json",
        ],
        agent_instructions: agentInstructions,
        contract_extract_ref: contractExtractRel,
      };

      const cycleStartPath = path.join(cycleDir, "cycle-start.json");
      const cycleStartRel = toRelativePath(target.root, cycleStartPath);
      payload.paths_written.push(cycleStartRel);
      await writeJsonFile(cycleStartPath, payload);

      if (json) {
        writeJson(payload);
      } else {
        writeLines([
          formatTargetLine(target),
          `cycle start: ${preflight.cycle_id}`,
          `queue: ${selectedId}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "abort") {
    const reason =
      typeof flags["reason"] === "string"
        ? flags["reason"].trim()
        : typeof flags["r"] === "string"
          ? flags["r"].trim()
          : "";
    if (!reason) {
      if (json) {
        writeJson({ ok: false, code: 1, error: { message: "Missing --reason." } });
      } else {
        writeLines(["Missing --reason.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const state = await readState(target.storePath);
      const activeCycleId = (state as typeof state & { activeCycleId?: string })
        .activeCycleId;
      const activeQueueId = (state as typeof state & { activeCycleQueueId?: string })
        .activeCycleQueueId;
      const activeStartedAt = (state as typeof state & { activeCycleStartedAt?: string })
        .activeCycleStartedAt;

      if (!activeCycleId) {
        if (json) {
          writeJson({
            ok: false,
            schema_version: CYCLE_ABORT_ERROR_SCHEMA,
            code: "NO_ACTIVE_CYCLE",
            message: "No active cycle state found.",
            suggested_fix: ["ato status --json", "ato q list --json"],
          });
        } else {
          writeLines(["No active cycle state found."]);
        }
        process.exitCode = 3;
        return;
      }

      const cycleDir = path.join(target.storePath, "cycles", activeCycleId);
      const cycleStatePath = path.join(cycleDir, "cycle-state.json");
      const cycleState = await readJson<Record<string, unknown>>(cycleStatePath, null);
      const queueId =
        (cycleState && typeof cycleState["queue_id"] === "string"
          ? cycleState["queue_id"]
          : null) ?? activeQueueId ?? null;
      const blockId =
        cycleState && typeof cycleState["block_id"] === "string"
          ? cycleState["block_id"]
          : null;
      const startedAt =
        (cycleState && typeof cycleState["started_at"] === "string"
          ? cycleState["started_at"]
          : null) ?? activeStartedAt ?? null;

      const gitStatus = await gatherGitStatus(target.root);
      const gitStatusPath = path.join(cycleDir, "cycle-abort-git-status.txt");
      const gitStatusLines = [
        gitStatus.status_sb ?? "",
        gitStatus.status_error ? `status_error: ${gitStatus.status_error}` : "",
        gitStatus.porcelain_error
          ? `porcelain_error: ${gitStatus.porcelain_error}`
          : "",
        gitStatus.dirty_paths?.length
          ? `dirty_paths: ${gitStatus.dirty_paths.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      await fs.writeFile(
        gitStatusPath,
        gitStatusLines.length ? `${gitStatusLines}\n` : "",
        "utf8",
      );

      const abortPath = path.join(cycleDir, "cycle-abort.json");
      const abortPayload = {
        schema_version: CYCLE_ABORT_SCHEMA,
        cycle_id: activeCycleId,
        queue_id: queueId,
        block_id: blockId,
        started_at: startedAt,
        aborted_at: new Date().toISOString(),
        reason,
        git_status_ref: toRelativePath(target.root, gitStatusPath),
        state_cleared: true,
      };
      await writeJsonFile(abortPath, abortPayload);

      const restState = { ...state };
      delete (restState as { activeCycleId?: string }).activeCycleId;
      delete (restState as { activeCycleQueueId?: string }).activeCycleQueueId;
      delete (restState as { activeCycleStartedAt?: string }).activeCycleStartedAt;
      await writeState(target.storePath, {
        ...restState,
        version: state.version ?? 1,
        targetId: target.id,
      });

      if (queueId) {
        const records = await readQueueItems(target.storePath);
        const items = records.map((record) => record.item);
        const found = items.findIndex((item) => item.id === queueId);
        if (found !== -1) {
          const existing = items[found];
          if (!existing) {
            throw new Error(`Queue item ${queueId} missing after lookup.`);
          }
          const existingNotes =
            typeof existing.notes === "string" ? existing.notes.trim() : "";
          const noteLine = `CycleAborted: ${activeCycleId} reason: ${reason} evidence: file:${toRelativePath(
            target.root,
            abortPath,
          )}`;
          const updatedBase: QueueItem = {
            ...existing,
            status: "queued",
            updated_at: new Date().toISOString(),
            notes: existingNotes ? `${existingNotes}\n${noteLine}` : noteLine,
          };
          if ("completed_at" in updatedBase) {
            delete (updatedBase as { completed_at?: string }).completed_at;
          }
          const updated: QueueItem = applyOriginIfMissing(
            updatedBase,
            await resolveCrossRepoOrigin(target),
          );
          items[found] = updated;
          await writeQueueItems(target.storePath, items);
          await writeViews(target.storePath, items);
        }
      }

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "cycle_abort",
        target_id: target.id,
        ...(queueId ? { queue_id: queueId } : {}),
        commands: [],
        artifacts: [toRelativePath(target.root, abortPath)],
        summary: `cycle abort ${activeCycleId}`,
      });

      if (json) {
        writeJson(abortPayload);
      } else {
        writeLines([
          formatTargetLine(target),
          `cycle abort: ${activeCycleId}`,
          `queue: ${queueId ?? "unknown"}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand !== "finish") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown cycle subcommand." } });
    } else {
      writeLines(["Unknown cycle subcommand.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
  try {
    const state = await readState(target.storePath);
    const activeCycleId = (state as typeof state & { activeCycleId?: string })
      .activeCycleId;
    const activeQueueId = (state as typeof state & { activeCycleQueueId?: string })
      .activeCycleQueueId;
    if (!activeCycleId) {
      const error = new Error("No active cycle state found.");
      (error as Error & { code?: number; details?: unknown }).code = 3;
      (error as Error & { details?: unknown }).details = {
        state_path: toRelativePath(target.root, path.join(target.storePath, "state.json")),
        guidance: ["Run: ato cycle start --json"],
      };
      throw error;
    }

    const cycleDir = path.join(target.storePath, "cycles", activeCycleId);
    const budgetMs = parseBudgetMs(flags["budget-ms"]);
    const allowAcceptance = isFlagEnabled(flags["run-acceptance"]);
    const allowGate = isFlagEnabled(flags["run-gate"]);
    const allowPackVerify = isFlagEnabled(flags["run-pack-verify"]);
    const finishStartedAt = Date.now();
    const progressPath = path.join(cycleDir, "finish-progress.json");
    const progressRel = toRelativePath(target.root, progressPath);
    const writeFinishProgress = async (step: string) => {
      const payload = buildFinishProgressPayload({
        cycleId: activeCycleId,
        step,
        elapsedMs: Date.now() - finishStartedAt,
        budgetMs,
      });
      await writeJsonFile(progressPath, payload);
      return payload;
    };
    const handleBudgetExhausted = async (step: string): Promise<boolean> => {
      const elapsedMs = Date.now() - finishStartedAt;
      if (elapsedMs < budgetMs) return false;
      const progress = await writeFinishProgress(step);
      const budgetPayload = buildBudgetExhaustedPayload({
        cycleId: activeCycleId,
        step,
        elapsedMs: progress.elapsed_ms,
        budgetMs,
        progressPath: progressRel,
      });
      if (json) {
        writeJson(budgetPayload);
      } else {
        writeLines([
          formatTargetLine(target),
          "cycle finish: budget exhausted",
          `cycle: ${activeCycleId}`,
          `step: ${step}`,
          `elapsed_ms: ${budgetPayload.error.details.elapsed_ms}`,
          `budget_ms: ${budgetPayload.error.details.budget_ms}`,
          `progress: ${budgetPayload.error.details.progress_path}`,
        ]);
      }
      process.exitCode = 2;
      return true;
    };
    const cycleStatePath = path.join(cycleDir, "cycle-state.json");
    const cycleState = await readJson<Record<string, unknown>>(cycleStatePath, null);
    if (!cycleState || typeof cycleState !== "object") {
      const error = new Error("Missing cycle-state.json for active cycle.");
      (error as Error & { code?: number; details?: unknown }).code = 3;
      (error as Error & { details?: unknown }).details = {
        cycle_state_path: toRelativePath(target.root, cycleStatePath),
        guidance: ["Re-run: ato cycle start --json"],
      };
      throw error;
    }

    const queueId =
      (typeof cycleState["queue_id"] === "string" && cycleState["queue_id"]) ||
      activeQueueId ||
      null;
    if (!queueId) {
      throw new Error("Active cycle is missing queue_id.");
    }

    const blockId =
      typeof cycleState["block_id"] === "string" ? cycleState["block_id"] : null;
    const block = blockId
      ? await loadBlockConfig(target.storePath, blockId)
      : null;
    if (blockId && !block) {
      throw new Error(`Block config missing for ${blockId}.`);
    }
    const blockFrozen = block ? isBlockFrozen(block) : false;
    const baselineTag = block ? resolveBaselineTag(block) : null;
    if (blockId && !baselineTag) {
      const error = new Error(`Block ${blockId} is missing a baseline tag.`);
      (error as Error & { code?: number; details?: unknown }).code = 3;
      (error as Error & { details?: unknown }).details = {
        block_id: blockId,
        guidance: [
          "Register a baseline tag in the block config.",
          "Create a baseline registry entry under .ato/meta/baselines.",
        ],
      };
      throw error;
    }
    if (blockId && baselineTag) {
      const baselineCheck = await verifyBaselineRegistry({
        root: target.root,
        store: target.storePath,
        tag: baselineTag,
      });
      if (!baselineCheck.ok) {
        const error = new Error("Baseline integrity check failed.");
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = baselineCheck;
        throw error;
      }
    }

    const { items, validation } = await loadQueueForWrite(target);
    ensureQueueValid(validation);
    const found = findItem(items, queueId);
    if (found.item.status !== "active") {
      throw new Error(`Queue item ${queueId} is not active.`);
    }

    const acceptance = found.item.spec?.acceptance_criteria ?? [];
    if (!acceptance.length) {
      throw new Error(`Queue item ${queueId} has no acceptance criteria.`);
    }

    const cycleStartPath = path.join(cycleDir, "cycle-start.json");
    const cycleStartRel = toRelativePath(target.root, cycleStartPath);
    const selectionPath = path.join(cycleDir, "selection.json");
    const selectionRel = toRelativePath(target.root, selectionPath);
    const preflightPath = path.join(cycleDir, "preflight.json");
    const preflightRel = toRelativePath(target.root, preflightPath);
    const contractIndexRel =
      typeof cycleState["contract_index_ref"] === "string"
        ? String(cycleState["contract_index_ref"])
        : toRelativePath(
            target.root,
            path.join(cycleDir, "contract-index.json"),
          );
    const contractExtractRel =
      typeof cycleState["contract_extract_ref"] === "string"
        ? String(cycleState["contract_extract_ref"])
        : toRelativePath(
            target.root,
            path.join(cycleDir, "contract-extract.json"),
          );
    const contractIndexPath = path.resolve(target.root, contractIndexRel);
    const contractExtractPath = path.resolve(target.root, contractExtractRel);
    try {
      await fs.access(contractIndexPath);
      await fs.access(contractExtractPath);
    } catch {
      const error = new Error("Missing cycle start artifacts required for finish.");
      (error as Error & { code?: number; details?: unknown }).code = 6;
      (error as Error & { details?: unknown }).details = {
        contract_index_ref: contractIndexRel,
        contract_extract_ref: contractExtractRel,
        guidance: [
          "Re-run: ato cycle start --json to regenerate cycle-start artifacts.",
        ],
      };
      throw error;
    }
    const acceptanceResults: CycleCheckRecord[] = [];
    const acceptanceArtifacts: string[] = [];
    const acceptanceAuditEntries: AcceptanceAuditEntry[] = [];
    const previousAcceptanceAudit = await readAcceptanceAudit(cycleDir);
    const gatePlaceholders: number[] = [];
    const cycleFinishPlaceholders: number[] = [];
    const packVerifyPlaceholders: number[] = [];

    for (let index = 0; index < acceptance.length; index += 1) {
      const entry = String(acceptance[index] ?? "").trim();
      const ordinal = index + 1;
      const { command, note } = extractCommand(entry);
      const commandText = command ?? "";
      const id = `acceptance-${String(ordinal).padStart(2, "0")}`;
      let parsedCmd: string[] = [];
      let parsedEnv: Record<string, string> = {};
      let normalizedCommand = commandText;

      const auditEntry: AcceptanceAuditEntry = {
        schema_version: "acceptance-audit-entry.v1",
        acceptance_id: id,
        raw: entry,
        parsed_cmd: [],
        env_overrides: {},
        command_identity: "",
        exit_code: null,
        sha256_of_stdout: null,
        sha256_of_stderr: null,
      };

      if (command) {
        try {
          const parsed = parseEnvPrefix(command);
          parsedCmd = parsed.cmd;
          parsedEnv = parsed.env;
          normalizedCommand = parsedCmd.join(" ");
          auditEntry.parsed_cmd = parsedCmd;
          auditEntry.env_overrides = parsedEnv;
          auditEntry.command_identity = buildAcceptanceCommandIdentity({
            raw: entry,
            parsed_cmd: parsedCmd,
            env_overrides: parsedEnv,
          });
        } catch (err) {
          const error = new Error(`Invalid acceptance command for ${id}.`);
          (error as Error & { code?: number; details?: unknown }).code = 3;
          (error as Error & { details?: unknown }).details = {
            acceptance_check: entry,
            error: (err as Error).message ?? String(err),
          };
          throw error;
        }
      }
      acceptanceAuditEntries.push(auditEntry);

      let existing = command
        ? await findExistingAcceptanceArtifact(cycleDir, ordinal)
        : null;
      const previousAudit = previousAcceptanceAudit.get(id) ?? null;
      if (command && existing) {
        const cacheMatches = acceptanceArtifactCacheMatches(
          previousAudit,
          auditEntry,
        );
        if (!cacheMatches) {
          if (allowAcceptance) {
            await clearAcceptanceArtifacts(cycleDir, ordinal);
          }
          existing = null;
        } else {
          await clearAcceptanceArtifacts(cycleDir, ordinal, existing);
        }
      }

      if (
        command &&
        !existing &&
        !allowAcceptance &&
        !isExpectedRefusal(note) &&
        !isCycleStartCommand(normalizedCommand) &&
        !isCycleFinishCommand(normalizedCommand) &&
        !isPackVerifyCommand(normalizedCommand) &&
        !isGateRunCommand(normalizedCommand)
      ) {
        const error = new Error(
          `Acceptance check ${id} requires explicit --run-acceptance.`,
        );
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          acceptance_check: entry,
          expected_artifact: toRelativePath(
            target.root,
            buildAcceptanceArtifact(cycleDir, ordinal, command),
          ),
          guidance: [
            "Run acceptance commands separately and store artifacts under .ato/cycles/<id>/acceptance-*.{log,json}.",
            "Re-run: ato cycle finish --json --run-acceptance --budget-ms <ms>",
          ],
        };
        throw error;
      }

      if (command && isExpectedRefusal(note)) {
        if (!existing) {
          const error = new Error(
            `Acceptance check ${id} expects refusal; capture output in ${path.basename(
              buildAcceptanceArtifact(cycleDir, ordinal, command),
            )} before finishing the cycle.`,
          );
          (error as Error & { code?: number; details?: unknown }).code = 3;
          (error as Error & { details?: unknown }).details = {
            acceptance_check: entry,
            expected_artifact: toRelativePath(
              target.root,
              buildAcceptanceArtifact(cycleDir, ordinal, command),
            ),
          };
          throw error;
        }
        const existingRel = toRelativePath(target.root, existing);
        await sanitizeAcceptanceArtifact(existing, target.root);
        acceptanceResults.push({
          id,
          command: commandText,
          status: "ok",
          artifacts: [existingRel],
          kind: "expected-refusal",
        });
        acceptanceArtifacts.push(existingRel);
        await updateAuditFromFile(auditEntry, existing, 1);
        continue;
      }

      if (command && isCycleStartCommand(normalizedCommand)) {
        const hasCycleStart = await readJson<Record<string, unknown>>(cycleStartPath, null);
        if (!hasCycleStart) {
          throw new Error("Missing cycle-start.json required by acceptance checks.");
        }
        await updateAuditFromFile(auditEntry, cycleStartPath, 0);
        acceptanceResults.push({
          id,
          command: commandText,
          status: "ok",
          artifacts: [cycleStartRel],
          kind: "cycle-start",
        });
        acceptanceArtifacts.push(cycleStartRel);
        continue;
      }

      if (command && isCycleFinishCommand(normalizedCommand)) {
        acceptanceResults.push({
          id,
          command: commandText,
          status: "unknown",
          kind: "cycle-finish",
        });
        cycleFinishPlaceholders.push(acceptanceResults.length - 1);
        continue;
      }

      if (command && isPackVerifyCommand(normalizedCommand)) {
        acceptanceResults.push({
          id,
          command: commandText,
          status: "unknown",
          kind: "pack-verify",
        });
        packVerifyPlaceholders.push(acceptanceResults.length - 1);
        continue;
      }

      if (command && isGateRunCommand(normalizedCommand)) {
        acceptanceResults.push({
          id,
          command: commandText,
          status: "unknown",
          kind: "gate",
        });
        gatePlaceholders.push(acceptanceResults.length - 1);
        continue;
      }

      if (!command) {
        acceptanceResults.push({
          id,
          command: entry,
          status: "skipped",
          kind: "unparsed",
        });
        continue;
      }

      if (existing) {
        await sanitizeAcceptanceArtifact(existing, target.root);
        await clearAcceptanceArtifacts(cycleDir, ordinal, existing);
        const existingRel = toRelativePath(target.root, existing);
        acceptanceResults.push({
          id,
          command: commandText,
          status: "ok",
          artifacts: [existingRel],
          kind: "pre-recorded",
        });
        acceptanceArtifacts.push(existingRel);
        await updateAuditFromFile(auditEntry, existing, 0);
        continue;
      }

      if (await handleBudgetExhausted(`acceptance:${id}`)) return;

      const artifactPath = buildAcceptanceArtifact(cycleDir, ordinal, command);
      const result = await runCommand({
        cmd: parsedCmd,
        cwd: target.root,
        env: { ATO_LOCK_BYPASS_PID: String(process.pid), ...parsedEnv },
      });
      updateAuditFromResult(auditEntry, result);
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter(Boolean)
        .join("\n");
      await writeLogFile(artifactPath, `${output}${output ? "\n" : ""}`);
      await sanitizeAcceptanceArtifact(artifactPath, target.root);
      await updateAuditFromFile(auditEntry, artifactPath, result.exitCode);
      await clearAcceptanceArtifacts(cycleDir, ordinal, artifactPath);
      const artifactRel = toRelativePath(target.root, artifactPath);
      acceptanceArtifacts.push(artifactRel);

      acceptanceResults.push({
        id,
        command: commandText,
        status: result.ok ? "ok" : "fail",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        artifacts: [artifactRel],
      });

      if (!result.ok) {
        const error = new Error(`Acceptance check failed: ${id}`);
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          command: commandText,
          exitCode: result.exitCode,
          artifact: artifactRel,
        };
        throw error;
      }
    }

    const gateMode = "full";
    const recommendation = await recommendGateMode({ root: target.root });
    const overridden = recommendation.mode !== gateMode;
    const artifactsDir = getArtifactsDir(target.storePath, queueId, "gate");
    const gatePath = path.join(cycleDir, "gate-full.json");

    let gate: {
      ok: boolean;
      mode: string;
      results: CycleCheckRecord[];
      totalDurationMs: number;
      plan: unknown;
      preflight: unknown;
      overrides: unknown;
      artifacts: string[];
    };

    if (!allowGate) {
      const existingGate = await readJson<Record<string, unknown>>(gatePath, null);
      if (!existingGate) {
        const error = new Error("Missing gate artifact for cycle finish.");
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          gate_path: toRelativePath(target.root, gatePath),
          guidance: [
            "Run: ato gate run --mode full --json",
            "Re-run: ato cycle finish --json --run-gate --budget-ms <ms>",
          ],
        };
        throw error;
      }
      const existingResultsRaw = Array.isArray(existingGate["results"])
        ? (existingGate["results"] as CycleCheckRecord[])
        : [];
      const existingResults = existingResultsRaw.map((entry) => {
        const artifactsRaw = Array.isArray(entry.artifacts)
          ? entry.artifacts
          : (entry as { artifact?: unknown }).artifact
            ? [(entry as { artifact?: unknown }).artifact]
            : [];
        const artifacts = artifactsRaw
          .filter((artifact): artifact is string => typeof artifact === "string")
          .map((artifact) => normalizeArtifactPath(target.root, artifact));
        const normalized: CycleCheckRecord = {
          id: entry.id,
          command: entry.command,
          ...(entry.kind ? { kind: entry.kind } : {}),
          ...(entry.status ? { status: entry.status } : {}),
          ...(typeof entry.exitCode === "number"
            ? { exitCode: entry.exitCode }
            : {}),
          ...(typeof entry.durationMs === "number"
            ? { durationMs: entry.durationMs }
            : {}),
          ...(artifacts.length ? { artifacts } : {}),
        };
        return normalized;
      });
      const existingArtifactsRaw = Array.isArray(existingGate["artifacts"])
        ? (existingGate["artifacts"] as unknown[])
        : [];
      const existingArtifacts = existingArtifactsRaw
        .filter((artifact): artifact is string => typeof artifact === "string")
        .map((artifact) => normalizeArtifactPath(target.root, artifact));
      const derivedArtifacts = existingResults.flatMap(
        (entry) => entry.artifacts ?? [],
      );
      gate = {
        ok: Boolean(existingGate["ok"]),
        mode: typeof existingGate["mode"] === "string" ? String(existingGate["mode"]) : gateMode,
        results: existingResults,
        totalDurationMs: Number(existingGate["total_duration_ms"] ?? 0),
        plan: existingGate["plan"] ?? null,
        preflight: existingGate["preflight"] ?? null,
        overrides: existingGate["overrides"] ?? null,
        artifacts: existingArtifacts.length
          ? existingArtifacts
          : derivedArtifacts.filter((entry) => Boolean(entry)),
      };
    } else {
      if (await handleBudgetExhausted("gate.run")) return;
      await runPluginHooks({
        target,
        hook: "gate.pre",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.pre",
          action: "gate",
          queueId,
          mode: gateMode,
          target: { id: target.id, root: target.root },
        },
      });

      const gateResult = await runGates({
        root: target.root,
        targetId: target.id,
        queueId,
        mode: gateMode,
        config: target.config,
        artifactsDir,
        env: resolveGateEnv(target.root),
        ...(blockId ? { blockId } : {}),
      });

      await runPluginHooks({
        target,
        hook: "gate.post",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.post",
          action: "gate",
          queueId,
          mode: gateMode,
          target: { id: target.id, root: target.root },
          metadata: { ok: gateResult.ok },
        },
      });

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "gate_run",
        target_id: target.id,
        queue_id: queueId,
        mode: gateResult.mode,
        commands: gateResult.results.map((result) => ({
          cmd: result.command,
          cwd: target.root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })),
        artifacts: gateResult.artifacts,
        summary: `gate ${gateResult.ok ? "ok" : "fail"}`,
      });

      const normalizedResults = gateResult.results.map((result) => {
        const artifacts = result.artifact
          ? [normalizeArtifactPath(target.root, result.artifact)]
          : [];
        const normalized: CycleCheckRecord = {
          id: result.id,
          command: result.command,
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          ...(artifacts.length ? { artifacts } : {}),
        };
        return normalized;
      });

      gate = {
        ok: gateResult.ok,
        mode: gateResult.mode,
        results: normalizedResults,
        totalDurationMs: gateResult.totalDurationMs,
        plan: gateResult.plan,
        preflight: gateResult.preflight,
        overrides: gateResult.overrides,
        artifacts: gateResult.artifacts
          .filter((artifact) => typeof artifact === "string" && artifact.trim())
          .map((artifact) => normalizeArtifactPath(target.root, artifact)),
      };
    }

    const gateResults = gate.results.map((result) => {
      const durationMs =
        typeof result.durationMs === "number" ? result.durationMs : 0;
      const artifacts = Array.isArray(result.artifacts)
        ? result.artifacts.map((artifact) =>
            normalizeArtifactPath(target.root, artifact),
          )
        : [];
      return {
        ...result,
        duration_ms: durationMs,
        ...(artifacts.length ? { artifacts } : {}),
      };
    });

    const obligations = await computeGateObligations({
      root: target.root,
      targetId: target.id,
      config: target.config,
      ...(blockId ? { blockId } : {}),
    });

    if (blockFrozen && blockId) {
      const sealCheck = await verifyBlockSeal({
        root: target.root,
        store: target.storePath,
        targetId: target.id,
        config: target.config,
        blockId,
        computed: obligations,
      });
      if (!sealCheck.ok) {
        const error = new Error("Block seal verification failed.");
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = sealCheck;
        throw error;
      }
    }

    const gatePayload = {
      ok: gate.ok,
      mode: gate.mode,
      results: gateResults,
      total_duration_ms: gate.totalDurationMs,
      plan: toJsonValue(gate.plan, target.root),
      preflight: toJsonValue(gate.preflight, target.root),
      overrides: toJsonValue(gate.overrides, target.root),
      obligations_hash: obligations.obligations_hash,
      recommendation: {
        mode: recommendation.mode,
        rationale: recommendation.rationale,
        risks: recommendation.risks,
        touched: recommendation.touched,
        changedFiles: recommendation.changedFiles,
        rules: recommendation.rules,
      },
      selected: { mode: gate.mode, overridden },
    };

    await writeJsonFile(gatePath, gatePayload);
    const gateRel = toRelativePath(target.root, gatePath);

    gatePlaceholders.forEach((idx) => {
      const record = acceptanceResults[idx];
      if (!record) return;
      record.status = gate.ok ? "ok" : "fail";
      record.artifacts = [gateRel];
    });
    const gateHash = await hashFileSha256(gatePath);
    gatePlaceholders.forEach((idx) => {
      const entry = acceptanceAuditEntries[idx];
      if (!entry) return;
      entry.exit_code = gate.ok ? 0 : 1;
      entry.sha256_of_stdout = gateHash;
      entry.sha256_of_stderr = null;
    });
    acceptanceArtifacts.push(gateRel);

    const acceptanceAuditPath = await writeAcceptanceAudit(
      cycleDir,
      acceptanceAuditEntries,
    );
    const acceptanceAuditRel = toRelativePath(target.root, acceptanceAuditPath);
    acceptanceArtifacts.push(acceptanceAuditRel);

    if (!gate.ok) {
      const failure = gate.results.find((result) => !isCycleCheckOk(result)) ?? null;
      const failureRecord =
        failure && typeof failure.exitCode === "number"
          ? { command: failure.command, exitCode: failure.exitCode }
          : null;
      const lesson = await maybeDraftLesson({
        store: target.storePath,
        queueId,
        failure: failureRecord,
      });
      const suggestionQuery = failure?.command ?? null;
      const lessons = await readLessonItems(target.storePath);
      const patterns = await readPatternItems(target.storePath);
      const suggestedLessons = suggestLessons({
        lessons,
        query: suggestionQuery,
        limit: 3,
      });
      const suggestedPatterns = suggestPatterns({
        patterns,
        query: suggestionQuery,
        limit: 3,
      });
      const suggestionLessonIds = suggestedLessons.map((entry) => entry.id);
      const suggestionPatternIds = suggestedPatterns.map((entry) => entry.id);
      let suggestionRecordError: string | null = null;
      try {
        await recordSuggestion({
          store: target.storePath,
          kind: "gate_failure",
          queueId,
          lessonId: lesson?.id ?? null,
          query: suggestionQuery,
          failure: failureRecord,
          suggestions: {
            lessons: suggestionLessonIds,
            patterns: suggestionPatternIds,
          },
        });
      } catch (err) {
        suggestionRecordError = (err as Error).message ?? String(err);
      }

      const nextActions = lesson
        ? [`Review lesson ${lesson.id} and refine prevention steps.`]
        : ["No lesson drafted yet. Consider: ato lesson add --input <json|path>"];
      nextActions.push(
        ...suggestedPatterns.map(
          (pattern) =>
            `Apply pattern: ato pattern apply --id ${pattern.id} --queue ${queueId}`,
        ),
      );
      const suggestionReason =
        suggestedLessons.length === 0 && suggestedPatterns.length === 0
          ? suggestionQuery
            ? `No matches for '${suggestionQuery}'.`
            : "No gate command available for suggestions."
          : null;

      const error = new Error("Quality gates failed.");
      (error as Error & { code?: number; details?: unknown }).code = 4;
      (error as Error & { details?: unknown }).details = {
        gate_path: gateRel,
        results: gate.results.map((result) => ({
          id: result.id,
          ok: isCycleCheckOk(result),
          ...(typeof result.exitCode === "number"
            ? { exitCode: result.exitCode }
            : {}),
          command: result.command,
        })),
        suggested_fix: nextActions,
        next_actions: nextActions,
        suggestions: {
          lessons: suggestedLessons.map((entry) => ({
            id: entry.id,
            pattern: entry.pattern,
            prevention: entry.prevention,
          })),
          patterns: suggestedPatterns.map((entry) => ({
            id: entry.id,
            title: entry.title,
            summary: entry.summary ?? null,
          })),
          ...(suggestionReason ? { reason: suggestionReason } : {}),
        },
        ...(suggestionRecordError
          ? { suggestion_record_error: suggestionRecordError }
          : {}),
      };
      throw error;
    }

    const evidenceEntries = [
      `file:${preflightRel}`,
      `file:${selectionRel}`,
      `file:${gateRel}`,
      `file:${cycleStartRel}`,
      `file:${contractIndexRel}`,
      `file:${contractExtractRel}`,
      ...acceptanceArtifacts.map((artifact) => `file:${artifact}`),
    ];

    const evidenceResult = await previewEvidenceInputs({
      target,
      queueId,
      entries: evidenceEntries,
    });
    const evidencePath = path.join(cycleDir, "q-evidence-add.json");
    await writeJsonFile(evidencePath, {
      ok: true,
      id: queueId,
      added: evidenceResult.added,
      total_inputs: evidenceResult.total,
    });
    const evidenceRel = toRelativePath(target.root, evidencePath);

    const packEntries = [
      preflightRel,
      selectionRel,
      gateRel,
      cycleStartRel,
      contractIndexRel,
      contractExtractRel,
      evidenceRel,
      ...acceptanceArtifacts,
      ...gate.artifacts,
    ];
    const packVerifyPath = path.join(cycleDir, "pack-verify.json");
    let packRef: {
      kind: "cycle_pack";
      cycle_id: string;
      path: string;
      manifest_path: string;
      sha256: string;
    };
    let packVerifyResult: PackVerifyResult;

    if (!allowPackVerify) {
      const existingPackVerify = await readJson<Record<string, unknown>>(
        packVerifyPath,
        null,
      );
      if (!existingPackVerify) {
        const error = new Error("Missing pack verify artifact for cycle finish.");
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          pack_verify_path: toRelativePath(target.root, packVerifyPath),
          guidance: [
            "Run: ato pack verify --path <pack> --json",
            "Re-run: ato cycle finish --json --run-pack-verify --budget-ms <ms>",
          ],
        };
        throw error;
      }
      packVerifyResult = existingPackVerify as PackVerifyResult;
      packRef = {
        kind: "cycle_pack",
        cycle_id: activeCycleId,
        path: String(packVerifyResult.pack_path ?? ""),
        manifest_path: String(packVerifyResult.manifest_path ?? ""),
        sha256: String(packVerifyResult.pack_sha256 ?? ""),
      };
    } else {
      if (await handleBudgetExhausted("pack.build")) return;
      const { pack_ref: builtPackRef } = await buildCycleEvidencePack({
        root: target.root,
        store: target.storePath,
        cycleId: activeCycleId,
        entries: packEntries,
      });
      packRef = builtPackRef;
      if (await handleBudgetExhausted("pack.verify")) return;
      packVerifyResult = await verifyCycleEvidencePack({
        root: target.root,
        packPath: packRef.path,
        manifestPath: packRef.manifest_path,
        expectedPackSha: packRef.sha256,
      });
      await writeJsonFile(packVerifyPath, packVerifyResult);
    }

    const packVerifyRel = toRelativePath(target.root, packVerifyPath);
    const packVerifySha = await hashFileSha256(packVerifyPath);
    const packVerifyRef = {
      kind: "pack_verify" as const,
      cycle_id: activeCycleId,
      path: packVerifyRel,
      sha256: packVerifySha,
      ok: Boolean(packVerifyResult.ok),
    };
    packVerifyPlaceholders.forEach((idx) => {
      const record = acceptanceResults[idx];
      if (!record) return;
      record.status = packVerifyResult.ok ? "ok" : "fail";
      record.artifacts = [packVerifyRel];
    });
    acceptanceArtifacts.push(packVerifyRel);
    if (!packVerifyResult.ok) {
      const error = new Error("Pack verification failed.");
      (error as Error & { code?: number; details?: unknown }).code = 3;
      (error as Error & { details?: unknown }).details = {
        pack_verify_path: packVerifyRel,
        failures: packVerifyResult.failures,
        missing_required: packVerifyResult.missing_required,
      };
      throw error;
    }

    const qDonePath = path.join(cycleDir, "q-done.json");
    const qDoneRel = toRelativePath(target.root, qDonePath);

    const cycleFinishPayload = {
      ok: true,
      schema_version: CYCLE_FINISH_SCHEMA,
      cycle_id: activeCycleId,
      queue_id: queueId,
      gate_ok: gate.ok,
      acceptance_checks: acceptance,
      pack_ref: packRef,
      pack_verify_ref: packVerifyRef,
      evidence_paths: [
        preflightRel,
        selectionRel,
        gateRel,
        cycleStartRel,
        evidenceRel,
        packVerifyRel,
        qDoneRel,
        packRef.path,
        packRef.manifest_path,
      ],
    };
    const cycleFinishPath = path.join(cycleDir, "cycle-finish.json");
    const cycleFinishRel = toRelativePath(target.root, cycleFinishPath);

    cycleFinishPlaceholders.forEach((idx) => {
      const record = acceptanceResults[idx];
      if (!record) return;
      record.status = "ok";
      record.artifacts = [cycleFinishRel];
    });
    acceptanceArtifacts.push(cycleFinishRel);

    const acceptanceResultsPath = path.join(cycleDir, "acceptance-results.json");
    await writeJsonFile(acceptanceResultsPath, {
      schema_version: "cycle-acceptance.v1",
      checks: acceptanceResults,
    });
    const acceptanceResultsRel = toRelativePath(target.root, acceptanceResultsPath);

    const selectionPayload = await readJson<JsonObject>(selectionPath, null);
    const selectionEvidence =
      selectionPayload && typeof selectionPayload === "object"
        ? (selectionPayload["selection_evidence"] as JsonObject | null)
        : null;
    if (!selectionEvidence) {
      throw new Error("Missing selection_evidence in selection.json.");
    }
    const cycleIndex = Number(selectionEvidence["cycle_index"]);
    if (!Number.isFinite(cycleIndex) || cycleIndex < 1) {
      throw new Error("Missing cycle_index in selection evidence.");
    }

    const preflightSha = await hashFileSha256(preflightPath);
    const gateArtifacts = await Promise.all(
      gate.artifacts.map(async (artifact) => {
        const resolved = path.isAbsolute(artifact)
          ? artifact
          : path.join(target.root, artifact);
        return {
          path: toRelativePath(target.root, resolved),
          sha256: await hashFileSha256(resolved),
        };
      }),
    );

    const existingCycles = await readCycleRecords(target.storePath);
    if (blockFrozen && blockId) {
      const lastDone = findLastDoneCycle(existingCycles, blockId);
      const previousHash = lastDone?.gate_evidence?.obligations_hash ?? null;
      if (previousHash && previousHash !== obligations.obligations_hash) {
        const error = new Error(
          "Gate obligations changed inside the active frozen block.",
        );
        (error as Error & { code?: number; details?: unknown }).code = 3;
        (error as Error & { details?: unknown }).details = {
          block_id: blockId,
          previous_cycle_id: lastDone?.id ?? null,
          previous_obligations_hash: previousHash,
          current_obligations_hash: obligations.obligations_hash,
          guidance: [
            "Open a new block_id with a new baseline for changed gate obligations.",
            "Do not weaken gate obligations mid-block.",
          ],
        };
        throw error;
      }
    }

    const cycleRecordPath = path.join(cycleDir, "cycle-record.json");
    const cycleRecordRel = toRelativePath(target.root, cycleRecordPath);
    const cycleRecord: CycleRecord = {
      schema_version: "cycle-record.v1",
      id: activeCycleId,
      ts: new Date().toISOString(),
      queue_id: queueId,
      ...(blockId ? { block_id: blockId } : {}),
      cycle_index: cycleIndex,
      hypothesis: found.item.spec?.outcome ?? found.item.title ?? "cycle",
      acceptance_checks: acceptance,
      evidence: normalizeEvidence([
        `file:${preflightRel}`,
        `file:${selectionRel}`,
        `file:${gateRel}`,
        `file:${cycleStartRel}`,
        `file:${cycleFinishRel}`,
        `file:${acceptanceResultsRel}`,
        `file:${evidenceRel}`,
        `file:${packVerifyRel}`,
        `file:${qDoneRel}`,
        `file:${packRef.path}`,
        `file:${packRef.manifest_path}`,
      ]),
      outcome: "ok",
      selection_evidence: selectionEvidence as unknown as CycleRecord["selection_evidence"],
      gate_evidence: {
        mode: "full",
        result: { ok: gate.ok },
        obligations_hash: obligations.obligations_hash,
        ...(gateArtifacts.length ? { artifacts: gateArtifacts } : {}),
      },
      preflight_evidence: { path: preflightRel, sha256: preflightSha },
      pack_ref: packRef,
      pack_verify_ref: packVerifyRef,
      checks: acceptanceResults,
    };

    await addEvidenceInputs({
      target,
      queueId,
      entries: evidenceEntries,
    });

    const { items: refreshedItems } = await loadQueueForWrite(target);
    const refreshedFound = findItem(refreshedItems, queueId);
    const completionEvidence = dedupeStable([
      ...packEntries,
      packRef.path,
      packRef.manifest_path,
      packVerifyRel,
    ]);
    const completionNoteResult = appendCompletionEvidenceNote({
      root: target.root,
      cycleId: activeCycleId,
      item: refreshedFound.item,
      evidence: completionEvidence,
    });
    const completionItem = completionNoteResult.item;
    if (completionNoteResult.added) {
      const autoEvidencePath = path.join(cycleDir, "auto-evidence-note.json");
      const normalizedEvidence = completionEvidence
        .map((entry) => normalizeEvidenceEntry(target.root, String(entry)))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      await writeJsonFile(autoEvidencePath, {
        ok: true,
        id: queueId,
        cycle_id: activeCycleId,
        note: completionItem.notes ?? "",
        evidence: normalizedEvidence,
      });
      refreshedItems[refreshedFound.index] = completionItem;
      await writeQueueItems(target.storePath, refreshedItems);
      await writeViews(target.storePath, refreshedItems);
    }
    ensureQueueCompletionEvidence(completionItem);

    await runPluginHooks({
      target,
      hook: "queue.pre",
      enabled: context.pluginsEnabled,
      payload: {
        hook: "queue.pre",
        action: "done",
        queueId,
        status: { from: found.item.status, to: "done" },
        target: { id: target.id, root: target.root },
      },
    });

    const origin = await resolveCrossRepoOrigin(target);
    const completedAt = new Date().toISOString();
    const updated: QueueItem = applyOriginIfMissing(
      {
        ...completionItem,
        status: "done",
        updated_at: completedAt,
        completed_at: completedAt,
      },
      origin,
    );
    updated.frozen = { core_hash: computeCoreHash(updated) };

    refreshedItems[refreshedFound.index] = updated;
    await writeQueueItems(target.storePath, refreshedItems);
    await writeViews(target.storePath, refreshedItems);

    await appendRunLog(target.storePath, {
      ts: new Date().toISOString(),
      kind: "queue_transition",
      target_id: target.id,
      queue_id: queueId,
      commands: [],
      artifacts: [],
      summary: "queue done",
    });

    await runPluginHooks({
      target,
      hook: "queue.post",
      enabled: context.pluginsEnabled,
      payload: {
        hook: "queue.post",
        action: "done",
        queueId,
        status: { from: found.item.status, to: "done" },
        target: { id: target.id, root: target.root },
      },
    });

    await writeJsonFile(qDonePath, { ok: true, id: queueId, status: "done" });
    acceptanceArtifacts.push(qDoneRel);
    await writeJsonFile(cycleFinishPath, cycleFinishPayload);
    await writeJsonFile(cycleRecordPath, cycleRecord as unknown as JsonValue);
    await appendCycleRecord({
      store: target.storePath,
      record: cycleRecord,
    });
    await appendRunLog(target.storePath, {
      ts: new Date().toISOString(),
      kind: "cycle_record",
      target_id: target.id,
      queue_id: queueId,
      commands: [],
      artifacts: [cycleRecordRel],
      summary: "cycle record",
    });

    const nextState = {
      ...state,
      version: state.version ?? 1,
      targetId: target.id,
      lastGate: {
        mode: "full",
        ok: gate.ok,
        ts: new Date().toISOString(),
      },
    } as Record<string, unknown>;
    delete nextState["activeCycleId"];
    delete nextState["activeCycleQueueId"];
    delete nextState["activeCycleStartedAt"];
    if ((nextState as { activeQueueId?: string }).activeQueueId === queueId) {
      delete nextState["activeQueueId"];
    }
    await writeState(target.storePath, nextState as typeof state);

    await runPluginHooks({
      target,
      hook: "cycle.post",
      enabled: context.pluginsEnabled,
      payload: {
        hook: "cycle.post",
        action: "finish",
        cycleId: activeCycleId,
        blockId: blockId ?? null,
        queueId,
        target: { id: target.id, root: target.root },
        metadata: {
          cycle_record_ref: {
            path: cycleRecordRel,
          },
          cycle_ledger_ref: {
            path: toRelativePath(
              target.root,
              path.join(target.storePath, "cycles", "ledger.jsonl"),
            ),
          },
          pack_ref: packRef,
          pack_verify_ref: packVerifyRef,
        },
      },
    });

    const payload = {
      ok: true,
      schema_version: CYCLE_FINISH_SCHEMA,
      cycle_id: activeCycleId,
      queue_id: queueId,
      gate_ok: gate.ok,
      acceptance_checks: acceptance,
      pack_ref: packRef,
      pack_verify_ref: packVerifyRef,
      paths_written: [
        preflightRel,
        selectionRel,
        gateRel,
        cycleStartRel,
        evidenceRel,
        packVerifyRel,
        qDoneRel,
        cycleFinishRel,
        acceptanceResultsRel,
        packRef.path,
        packRef.manifest_path,
        cycleRecordRel,
      ],
    };

    if (json) {
      writeJson(payload);
    } else {
      writeLines([
        formatTargetLine(target),
        `cycle finish: ${activeCycleId}`,
        `queue: ${queueId}`,
      ]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
