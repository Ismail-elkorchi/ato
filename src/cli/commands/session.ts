import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import { resolveTarget } from "../../core/targets/resolve.js";
import {
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
  ensureCrossStoreWriteAllowed,
} from "./shared.js";
import { buildCloseoutPlan, buildQueueItemsFromDrafts } from "../../core/session/closeout.js";
import { buildIntakeItem } from "../../core/queue/intake.js";
import { readQueueItems, writeQueueItems, nextQueueId } from "../../core/queue/store.js";
import { validateQueueItems } from "../../core/queue/validate.js";
import { appendRunLog } from "../../core/runlog.js";
import { writeViews } from "./q.js";
import { stableStringify } from "../../core/fs.js";
import type { CommandContext } from "../types.js";
import type { JsonObject, QueueItem, QueueOrigin } from "../../core/types.js";

const loadQueueSchema = async (): Promise<JsonObject> => {
  const schemaUrl = new URL(
    "../../core/schemas/queue.v2.json",
    import.meta.url,
  );
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw) as JsonObject;
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
  (error as Error & { code?: number; details?: unknown }).code =
    contractError ? 6 : 3;
  (error as Error & { details?: unknown }).details = { errors };
  throw error;
};

const CLOSEOUT_HELP: { root: string[]; plan: string[]; apply: string[] } = {
  root: [
    "Usage: ato session closeout <plan|apply> [options]",
    "",
    "Options:",
    "  --gate-run <path>      Optional gate --json output",
    "  --dest <path|id>       Destination store for cross-store apply (optional)",
    "  --allow-cross-store-write  Allow cross-store writes to --dest",
    "  --telemetry-ref <ref>  Optional telemetry snapshot ref",
    "  --force                Include ineligible items as blocked",
    "",
    "Examples:",
    "  ato session closeout plan --json",
    "  ato session closeout apply --dest /path/to/dest --allow-cross-store-write --json",
  ],
  plan: [
    "Usage: ato session closeout plan [options]",
    "",
    "Options:",
    "  --gate-run <path>      Optional gate --json output",
    "  --dest <path|id>       Destination store (optional; no writes)",
    "  --telemetry-ref <ref>  Optional telemetry snapshot ref",
    "",
    "Example:",
    "  ato session closeout plan --gate-run .ato/runs/last-gate.json --json",
  ],
  apply: [
    "Usage: ato session closeout apply [options]",
    "",
    "Options:",
    "  --gate-run <path>      Optional gate --json output",
    "  --dest <path|id>       Destination store for cross-store apply (optional)",
    "  --allow-cross-store-write  Allow cross-store writes to --dest",
    "  --telemetry-ref <ref>  Optional telemetry snapshot ref",
    "  --force                Include ineligible items as blocked",
    "",
    "Example:",
    "  ato session closeout apply --dest /path/to/dest --allow-cross-store-write --json",
  ],
};

const getCloseoutHelp = (action: string | null): string[] => {
  if (action === "plan") return CLOSEOUT_HELP.plan;
  if (action === "apply") return CLOSEOUT_HELP.apply;
  return CLOSEOUT_HELP.root;
};

const normalizePath = (value: string): string => value.split(path.sep).join("/");

const hashContent = (content: string): string =>
  crypto.createHash("sha256").update(content).digest("hex");

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
  if (!hasGitDir(repoRoot)) return null;
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
  return normalizePath(relative);
};

const buildCloseoutOrigin = ({
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

const TRANSFER_STATUSES = new Set(["queued", "active"]);

const ELIGIBLE_REASON_OK = "meets closeout eligibility checks";
const REASON_MISSING_ORIGIN = "missing origin (producer repo identity unavailable)";
const REASON_CONTRACT_REFS = "invalid contract refs for destination";

const buildTransferItems = (items: QueueItem[]) =>
  [...items]
    .filter((item) => TRANSFER_STATUSES.has(item.status))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
    }));

const hasText = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

const hasList = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

const hasOrigin = (origin: QueueOrigin | undefined): boolean =>
  Boolean(
    origin &&
      hasText(origin.commit) &&
      (hasText(origin.repo_remote) || hasText(origin.repo_path)),
  );

const decodePointerSegment = (value: string): string =>
  value.replace(/~1/g, "/").replace(/~0/g, "~");

const formatInstancePath = (value: string | undefined): string => {
  if (!value || value === "/") return "item";
  const parts = value
    .split("/")
    .slice(1)
    .map((part) => decodePointerSegment(part));
  let out = "";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      out += `[${part}]`;
    } else {
      out = out ? `${out}.${part}` : part;
    }
  }
  return out || "item";
};

const inferFieldFromMessage = (message: string): string | null => {
  const match = message.match(/\bspec\.[a-z_]+/i);
  if (match) return match[0];
  if (message.includes("contract ref")) return "spec.contract_refs";
  if (message.includes("target")) return "target.selector";
  if (message.includes("origin")) return "origin";
  return null;
};

const guidanceForField = (field: string, message: string): string => {
  if (field.startsWith("spec.contract_refs") || message.includes("contract ref")) {
    return "Update spec.contract_refs to valid destination sections; run `ato contract index` in the destination repo.";
  }
  if (field.startsWith("spec.problem")) {
    return "Add spec.problem describing the issue to solve.";
  }
  if (field.startsWith("spec.outcome")) {
    return "Add spec.outcome describing the desired end state.";
  }
  if (field.startsWith("spec.plan")) {
    return "Add spec.plan with deterministic steps.";
  }
  if (field.startsWith("spec.acceptance_criteria")) {
    return "Add spec.acceptance_criteria with verifiable checks.";
  }
  if (field.startsWith("spec.inputs")) {
    return "Add spec.inputs with evidence paths or commands.";
  }
  if (field.startsWith("spec.deliverables")) {
    return "Add spec.deliverables describing expected outputs.";
  }
  if (field.startsWith("target.selector")) {
    return "Set target.selector to exact/range/milestone for open items.";
  }
  if (field.startsWith("origin")) {
    return "Ensure origin metadata is present (use intake/transfer to populate).";
  }
  return "Update the item to satisfy the reported validation error.";
};

const guidanceForGlobalError = (message: string): string => {
  if (message.includes("Missing contract index")) {
    return "Run `ato contract index` in the destination repo to build the contract index.";
  }
  if (message.includes("Missing contract doc path")) {
    return "Set destination contracts.platform to a valid contract doc path.";
  }
  return "Resolve the reported validation error in the destination repo.";
};

type CloseoutValidationIssue = {
  id: string;
  title: string;
  reasons: string[];
  fields: string[];
  guidance: string[];
};

const buildValidationIssues = ({
  errors,
  destIdToSourceId,
  sourceById,
}: {
  errors: Array<{ id: string; message: string; details?: { instance_path?: string; unexpected_key?: string } }>;
  destIdToSourceId: Map<string, string>;
  sourceById: Map<string, QueueItem>;
}): {
  issues: CloseoutValidationIssue[];
  global: Array<{ message: string; guidance: string }>;
} => {
  const issues = new Map<
    string,
    { id: string; title: string; reasons: Set<string>; fields: Set<string>; guidance: Set<string> }
  >();
  const global = new Map<string, string>();

  for (const error of errors) {
    if (error.id === "contract_refs") {
      const guidance = guidanceForGlobalError(error.message);
      global.set(error.message, guidance);
      continue;
    }
    const sourceId = destIdToSourceId.get(error.id) ?? error.id;
    const sourceItem = sourceById.get(sourceId);
    if (!sourceItem) {
      const guidance = guidanceForGlobalError(error.message);
      global.set(error.message, guidance);
      continue;
    }
    const entry =
      issues.get(sourceId) ??
      {
        id: sourceId,
        title: sourceItem.title,
        reasons: new Set<string>(),
        fields: new Set<string>(),
        guidance: new Set<string>(),
      };
    entry.reasons.add(error.message);

    const instanceField = formatInstancePath(error.details?.instance_path);
    if (instanceField !== "item") entry.fields.add(instanceField);
    if (error.details?.unexpected_key) {
      entry.fields.add(`${instanceField}.${error.details.unexpected_key}`);
    }
    const inferred = inferFieldFromMessage(error.message);
    if (inferred) entry.fields.add(inferred);

    if (entry.fields.size) {
      for (const field of entry.fields) {
        entry.guidance.add(guidanceForField(field, error.message));
      }
    } else {
      entry.guidance.add(guidanceForField("item", error.message));
    }

    issues.set(sourceId, entry);
  }

  const issueList: CloseoutValidationIssue[] = [...issues.values()]
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      reasons: [...entry.reasons].sort((a, b) => a.localeCompare(b)),
      fields: [...entry.fields].sort((a, b) => a.localeCompare(b)),
      guidance: [...entry.guidance].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const globalList = [...global.entries()]
    .map(([message, guidance]) => ({ message, guidance }))
    .sort((a, b) => a.message.localeCompare(b.message));

  return { issues: issueList, global: globalList };
};

const mergeEligibility = ({
  eligibility,
  issues,
}: {
  eligibility: {
    eligible: Array<{ id: string; title: string; why_eligible: string }>;
    ineligible: Array<{ id: string; title: string; reasons: string[] }>;
  };
  issues: CloseoutValidationIssue[];
}): {
  eligible: Array<{ id: string; title: string; why_eligible: string }>;
  ineligible: Array<{ id: string; title: string; reasons: string[] }>;
} => {
  const eligible = new Map(
    eligibility.eligible.map((entry) => [entry.id, entry]),
  );
  const ineligible = new Map(
    eligibility.ineligible.map((entry) => [entry.id, entry]),
  );

  for (const issue of issues) {
    if (eligible.has(issue.id)) {
      eligible.delete(issue.id);
    }
    const existing = ineligible.get(issue.id);
    const reasons = new Set(existing?.reasons ?? []);
    for (const reason of issue.reasons) reasons.add(reason);
    ineligible.set(issue.id, {
      id: issue.id,
      title: existing?.title ?? issue.title,
      reasons: [...reasons].sort((a, b) => a.localeCompare(b)),
    });
  }

  return {
    eligible: [...eligible.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ineligible: [...ineligible.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
};

const buildContractRefsFixCommand = ({
  destRoot,
  ids,
}: {
  destRoot: string;
  ids: string[];
}): string | null => {
  if (!ids.length) return null;
  const idList = [...ids].sort((a, b) => a.localeCompare(b)).join(",");
  return `ato q contract-refs fix --ids ${idList} --dest ${destRoot} --apply --json`;
};

const hasTargetSelector = (item: QueueItem): boolean => {
  const selector = item.target?.selector ?? item.target?.kind ?? "unbounded";
  return selector !== "unbounded";
};

const classifyCloseoutItems = ({
  items,
  originAvailable,
}: {
  items: QueueItem[];
  originAvailable: boolean;
}): {
  eligible: Array<{ id: string; title: string; why_eligible: string }>;
  ineligible: Array<{ id: string; title: string; reasons: string[] }>;
} => {
  const eligible: Array<{ id: string; title: string; why_eligible: string }> = [];
  const ineligible: Array<{ id: string; title: string; reasons: string[] }> = [];
  const candidates = items
    .filter((item) => TRANSFER_STATUSES.has(item.status))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const item of candidates) {
    const reasons: string[] = [];
    const spec = item.spec ?? {};
    if (!hasText(spec.problem)) reasons.push("missing spec.problem");
    if (!hasText(spec.outcome)) reasons.push("missing spec.outcome");
    if (!hasList(spec.plan?.steps)) reasons.push("missing spec.plan.steps");
    if (!hasList(spec.acceptance_criteria)) {
      reasons.push("missing spec.acceptance_criteria");
    }
    if (!hasList(spec.inputs)) reasons.push("missing spec.inputs");
    if (!hasList(spec.deliverables)) reasons.push("missing spec.deliverables");
    if (!hasList(spec.contract_refs)) {
      reasons.push("missing spec.contract_refs");
    }
    if (!hasTargetSelector(item)) {
      reasons.push("missing target selector");
    }
    if (!originAvailable && !hasOrigin(item.origin)) {
      reasons.push(REASON_MISSING_ORIGIN);
    }
    if (reasons.length) {
      ineligible.push({ id: item.id, title: item.title, reasons });
    } else {
      eligible.push({ id: item.id, title: item.title, why_eligible: ELIGIBLE_REASON_OK });
    }
  }
  return { eligible, ineligible };
};

const appendNoteLine = (notes: string | undefined, line: string): string => {
  const base = typeof notes === "string" ? notes.trimEnd() : "";
  if (base.includes(line)) return base;
  return base ? `${base}\n${line}` : line;
};

const writeCloseoutArtifact = async ({
  root,
  storePath,
  name,
  payload,
}: {
  root: string;
  storePath: string;
  name: string;
  payload: JsonObject;
}): Promise<{ path: string; sha256: string }> => {
  const dir = path.join(storePath, "closeout");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const content = `${stableStringify(payload)}\n`;
  await fs.writeFile(filePath, content, "utf8");
  return {
    path: normalizePath(path.relative(root, filePath)),
    sha256: hashContent(content),
  };
};

const formatPlanLines = (plan: JsonObject) => [
  `plan: ${String(plan["schema_version"] ?? "unknown")}`,
  `drafts: ${Array.isArray(plan["drafts"]) ? plan["drafts"].length : 0}`,
  Array.isArray((plan["gate"] as { failures?: unknown })?.failures) &&
  ((plan["gate"] as { failures: unknown[] }).failures.length > 0)
    ? `gate failures: ${(plan["gate"] as { failures: unknown[] }).failures.length}`
    : "gate failures: none",
];

export const runSessionCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  if (!subcommand) {
    writeLines(["Usage: ato session closeout <plan|apply> [options]"]);
    return;
  }
  const { flags, positionals } = parseFlags(args);

  if (subcommand !== "closeout") {
    writeLines([
      "Unknown session subcommand.",
      "Usage: ato session closeout <plan|apply> [options]",
    ]);
    process.exitCode = 1;
    return;
  }

  const gateRunPath =
    typeof flags["gate-run"] === "string" ? flags["gate-run"].trim() : null;
  const action = positionals[0] ?? null;
  if (flags["help"]) {
    writeLines(getCloseoutHelp(action));
    return;
  }
  if (action && action !== "plan" && action !== "apply") {
    throw new Error(`Unknown closeout action '${action}'.`);
  }
  if (action === "plan" && flags["apply"]) {
    throw new Error("Use either 'plan' or --apply, not both.");
  }
  const apply = action === "apply" || Boolean(flags["apply"]);
  const telemetryRef =
    typeof flags["telemetry-ref"] === "string"
      ? flags["telemetry-ref"].trim()
      : typeof flags["telemetryRef"] === "string"
        ? flags["telemetryRef"].trim()
        : null;
  const destFlag = flags["dest"];
  if (destFlag === true) {
    throw new Error("Missing value for --dest.");
  }
  const destSelection =
    typeof destFlag === "string" && destFlag.trim() ? destFlag.trim() : null;
  const allowCrossStoreWrite = Boolean(
    flags["allow-cross-store-write"] || flags["allowCrossStoreWrite"],
  );

  const { target: sourceTarget } = await resolveTarget({
    cwd: process.cwd(),
    selection: context.repo ?? process.env["ATO_REPO"] ?? null,
    storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
    requireWrite: apply,
  });
  await ensureProtocol(sourceTarget.root);

  const records = await readQueueItems(sourceTarget.storePath);
  const items = records.map((record) => record.item);
  const plan = await buildCloseoutPlan({
    root: sourceTarget.root,
    gateRunPath,
  });
  const origin = buildCloseoutOrigin({
    repoRoot: sourceTarget.root,
    cwd: process.cwd(),
  });
  const eligibility = classifyCloseoutItems({
    items,
    originAvailable: Boolean(origin),
  });
  const destinationTarget = destSelection ?? null;
  const transferItems = buildTransferItems(items);
  const planPayload: JsonObject = {
    schema_version: plan.schema_version,
    origin,
    destination_target: destinationTarget,
    transfer_items: transferItems,
    eligible_items: eligibility.eligible,
    ineligible_items: eligibility.ineligible,
    contracts_consulted: plan.contracts_consulted,
    gate: plan.gate,
    drafts: plan.drafts,
    limits: plan.limits,
    warnings: plan.warnings,
  };

  if (!apply) {
    const artifact = await writeCloseoutArtifact({
      root: sourceTarget.root,
      storePath: sourceTarget.storePath,
      name: "closeout-plan.json",
      payload: planPayload,
    });
    if (context.json) {
      writeJson({ ok: true, plan: planPayload, artifact });
    } else {
      writeLines([
        ...formatPlanLines(planPayload),
        `artifact: ${artifact.path}`,
        `sha256: ${artifact.sha256}`,
      ]);
    }
    return;
  }

  const force = Boolean(flags["force"]);
  const destTarget = destSelection
    ? (
        await resolveTarget({
          cwd: process.cwd(),
          selection: destSelection,
          storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
          requireWrite: true,
        })
      ).target
    : null;
  if (destTarget) {
    await ensureProtocol(destTarget.root);
    await ensureCrossStoreWriteAllowed({
      sourceTarget,
      destTarget,
      allowFlag: allowCrossStoreWrite,
      command: "session closeout apply",
    });
  }

  const lockPath = await acquireWriteLock(
    sourceTarget,
    sourceTarget.config.lock?.ttlMs,
  );
  const destLockPath =
    destTarget && destTarget.root !== sourceTarget.root
      ? await acquireWriteLock(destTarget, destTarget.config.lock?.ttlMs)
      : null;
  try {
    const timestamp = new Date().toISOString();
    const { created, nextItems } = buildQueueItemsFromDrafts({
      drafts: plan.drafts,
      existingItems: items,
      timestamp,
    });

    const schema = await loadQueueSchema();
    const validation = await validateQueueItems({
      items: nextItems,
      schema,
      config: sourceTarget.config,
      root: sourceTarget.root,
      store: sourceTarget.storePath,
    });
    ensureQueueValid(validation);

    const eligibility = classifyCloseoutItems({
      items: nextItems,
      originAvailable: Boolean(origin),
    });
    const eligibleItems = eligibility.eligible;
    const ineligibleItems = eligibility.ineligible;
    const ineligibleById = new Map(
      ineligibleItems.map((entry) => [entry.id, entry.reasons]),
    );

    const sourceById = new Map(nextItems.map((item) => [item.id, item]));

    if (!destTarget) {
      if (created.length) {
        await writeQueueItems(sourceTarget.storePath, nextItems);
        await writeViews(sourceTarget.storePath, nextItems);
        await appendRunLog(sourceTarget.storePath, {
          ts: new Date().toISOString(),
          kind: "queue_transition",
          target_id: sourceTarget.id,
          queue_ids: created.map((item) => item.id),
          commands: [],
          artifacts: [],
          summary: "session closeout apply",
        });
      }

      const resultPayload: JsonObject = {
        schema_version: "session-closeout.apply.v1",
        origin,
        destination_target: null,
        eligible_items: eligibility.eligible,
        ineligible_items: eligibility.ineligible,
        transfer_items: [],
        created_ids: created.map((item) => item.id),
        mapping: {},
        audit: [],
        evidence_added: [],
        telemetry_snapshot_ref: telemetryRef,
        gate_run_ref: plan.gate.path ?? null,
        force,
        receipt: null,
      };

      const artifact = await writeCloseoutArtifact({
        root: sourceTarget.root,
        storePath: sourceTarget.storePath,
        name: "closeout-apply.json",
        payload: resultPayload,
      });

      if (context.json) {
        writeJson({ ok: true, result: resultPayload, artifact, sha256: artifact.sha256 });
      } else {
        writeLines([
          `closeout: applied (${created.length} drafts)`,
          `artifact: ${artifact.path}`,
          `sha256: ${artifact.sha256}`,
        ]);
      }
      return;
    }

    const transferCandidates = force
      ? [...eligibleItems, ...ineligibleItems]
      : [...eligibleItems];
    const transferOrder = [...transferCandidates].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );

    const destRecords = await readQueueItems(destTarget.storePath);
    const destItems = destRecords.map((record) => record.item);

    const sourceGitHead = readGitHead(sourceTarget.root);
    const transferTimestamp = timestamp;

    const mapping: Record<string, string | { error: string; reasons?: string[] }> =
      {};
    const auditEntries: Array<{
      source_id: string;
      dest_id: string | null;
      source_repo_path: string;
      source_item_id: string;
      transfer_timestamp: string;
      source_git_head: string | null;
      blocked: boolean;
      block_reasons: string[];
    }> = [];
    const transferItems: QueueItem[] = [];
    let currentItems = [...destItems];

    for (const entry of transferOrder) {
      const sourceItem = sourceById.get(entry.id);
      if (!sourceItem) {
        mapping[entry.id] = { error: "missing source item" };
        continue;
      }
      const nextId = nextQueueId(currentItems);
      const intakeItem = buildIntakeItem({
        candidate: sourceItem,
        id: nextId,
        sourceRepo: sourceTarget.root,
        ingestedAt: transferTimestamp,
        telemetryRef,
        originFallback: origin,
      });
      const auditParts = [
        `source_repo_path=${sourceTarget.root}`,
        `source_item_id=${sourceItem.id}`,
        `transfer_timestamp=${transferTimestamp}`,
      ];
      if (sourceGitHead) {
        auditParts.push(`source_git_head=${sourceGitHead}`);
      }
      const auditLine = `Transfer: ${auditParts.join("; ")}`;
      let transferItem: QueueItem = {
        ...intakeItem,
        notes: appendNoteLine(intakeItem.notes, auditLine),
      };

      const blockReasons = ineligibleById.get(entry.id) ?? [];
      if (force && blockReasons.length) {
        transferItem = {
          ...transferItem,
          status: "blocked",
          notes: appendNoteLine(
            transferItem.notes,
            `Closeout force blocked: ${blockReasons.join("; ")}`,
          ),
        };
      }

      mapping[sourceItem.id] = nextId;
      auditEntries.push({
        source_id: sourceItem.id,
        dest_id: nextId,
        source_repo_path: sourceTarget.root,
        source_item_id: sourceItem.id,
        transfer_timestamp: transferTimestamp,
        source_git_head: sourceGitHead,
        blocked: force && blockReasons.length > 0,
        block_reasons: blockReasons,
      });

      transferItems.push(transferItem);
      currentItems = [...currentItems, transferItem];
    }

    if (!force) {
      for (const entry of ineligibleItems) {
        mapping[entry.id] = { error: "ineligible", reasons: entry.reasons };
      }
    }

    const receiptBasis = stableStringify({
      source_repo: sourceTarget.root,
      destination_target: destTarget.root,
      mapping,
    });
    const receiptHash = hashContent(receiptBasis);
    const receiptAbsPath = path.join(
      destTarget.storePath,
      "intake",
      "receipts",
      `${receiptHash}.json`,
    );
    const receiptRelPath = normalizePath(
      path.relative(destTarget.root, receiptAbsPath),
    );
    const receiptLine = `Closeout receipt: ${receiptRelPath}`;

    const transferItemsWithReceipt = transferItems.map((item) => ({
      ...item,
      notes: appendNoteLine(item.notes, receiptLine),
    }));

    const evidenceAdded = transferItemsWithReceipt
      .map((item) => ({
        queue_id: item.id,
        receipt_path: receiptRelPath,
      }))
      .sort((a, b) => a.queue_id.localeCompare(b.queue_id));

    const destValidation = await validateQueueItems({
      items: [...destItems, ...transferItemsWithReceipt],
      schema,
      config: destTarget.config,
      root: destTarget.root,
      store: destTarget.storePath,
    });
    if (destValidation.errors.length) {
      const destIdToSourceId = new Map(
        auditEntries
          .filter((entry) => entry.dest_id)
          .map((entry) => [entry.dest_id as string, entry.source_id]),
      );
      const validationReport = buildValidationIssues({
        errors: destValidation.errors,
        destIdToSourceId,
        sourceById,
      });
      const contractRefIds = validationReport.issues
        .filter((issue) =>
          issue.reasons.some((reason) => reason.includes("contract ref")),
        )
        .map((issue) => issue.id)
        .sort((a, b) => a.localeCompare(b));
      const contractRefsFixCommand = buildContractRefsFixCommand({
        destRoot: destTarget.root,
        ids: contractRefIds,
      });
      const contractRefsFix = contractRefsFixCommand
        ? { ids: contractRefIds, command: contractRefsFixCommand }
        : null;
      const issuesWithFix = contractRefsFixCommand
        ? validationReport.issues.map((issue) => {
            if (!issue.reasons.some((reason) => reason.includes("contract ref"))) {
              return issue;
            }
            const guidance = new Set(issue.guidance);
            guidance.add(`Run: ${contractRefsFixCommand}`);
            return {
              ...issue,
              guidance: [...guidance].sort((a, b) => a.localeCompare(b)),
            };
          })
        : validationReport.issues;
      const mergedEligibility = mergeEligibility({
        eligibility,
        issues: issuesWithFix.map((issue) => ({
          ...issue,
          reasons: issue.reasons.some((reason) => reason.includes("contract ref"))
            ? [...issue.reasons, REASON_CONTRACT_REFS]
            : issue.reasons,
        })),
      });
      const blockedIds = issuesWithFix.map((issue) => issue.id);
      const blockedById = new Map(
        issuesWithFix.map((issue) => [issue.id, issue.reasons]),
      );
      const mappingBlocked: Record<string, { error: string; reasons?: string[] }> =
        {};
      for (const entry of transferOrder) {
        const reasons = blockedById.get(entry.id) ?? [];
        mappingBlocked[entry.id] = {
          error: "blocked",
          reasons: reasons.length
            ? reasons
            : ["Blocked by destination validation errors."],
        };
      }
      for (const entry of ineligibleItems) {
        mappingBlocked[entry.id] = { error: "ineligible", reasons: entry.reasons };
      }

      const resultPayload: JsonObject = {
        schema_version: "session-closeout.apply.v1",
        status: "blocked",
        origin,
        destination_target: destinationTarget,
        eligible_items: mergedEligibility.eligible,
        ineligible_items: mergedEligibility.ineligible,
        transfer_items: [],
        created_ids: [],
        mapping: mappingBlocked,
        audit: auditEntries,
        evidence_added: [],
        telemetry_snapshot_ref: telemetryRef,
        gate_run_ref: plan.gate.path ?? null,
        force,
        blocked_ids: blockedIds,
        blocked_items: issuesWithFix,
        blocking_errors: validationReport.global,
        contract_refs_fix: contractRefsFix,
        receipt: null,
      };

      const artifact = await writeCloseoutArtifact({
        root: sourceTarget.root,
        storePath: sourceTarget.storePath,
        name: "closeout-apply.json",
        payload: resultPayload,
      });

      if (context.json) {
        writeJson({
          ok: false,
          error: {
            message: "Closeout apply blocked by destination validation errors.",
            details: {
              blocked_ids: blockedIds,
              blocked_items: issuesWithFix,
              blocking_errors: validationReport.global,
              contract_refs_fix: contractRefsFix,
            },
          },
          result: resultPayload,
          artifact,
          sha256: artifact.sha256,
        });
      } else {
        const lines = [
          "closeout: blocked",
          `blocked items: ${blockedIds.length}`,
          validationReport.global.length
            ? `blocking errors: ${validationReport.global.length}`
            : null,
          `artifact: ${artifact.path}`,
          `sha256: ${artifact.sha256}`,
        ];
        writeLines(lines);
      }
      process.exitCode = destValidation.contractError ? 6 : 3;
      return;
    }

    const transferSummary = transferOrder
      .map((entry) => {
        const sourceItem = sourceById.get(entry.id);
        if (!sourceItem) return null;
        const blockReasons = ineligibleById.get(entry.id) ?? [];
        const status = (force && blockReasons.length
          ? "blocked"
          : sourceItem.status) as QueueItem["status"];
        return { id: sourceItem.id, title: sourceItem.title, status };
      })
      .filter(
        (entry): entry is { id: string; title: string; status: QueueItem["status"] } =>
          Boolean(entry),
      );

    if (created.length) {
      await writeQueueItems(sourceTarget.storePath, nextItems);
      await writeViews(sourceTarget.storePath, nextItems);
      await appendRunLog(sourceTarget.storePath, {
        ts: new Date().toISOString(),
        kind: "queue_transition",
        target_id: sourceTarget.id,
        queue_ids: created.map((item) => item.id),
        commands: [],
        artifacts: [],
        summary: "session closeout apply",
      });
    }

    if (transferItemsWithReceipt.length) {
      await writeQueueItems(destTarget.storePath, [
        ...destItems,
        ...transferItemsWithReceipt,
      ]);
      await writeViews(destTarget.storePath, [
        ...destItems,
        ...transferItemsWithReceipt,
      ]);
      await appendRunLog(destTarget.storePath, {
        ts: new Date().toISOString(),
        kind: "queue_transition",
        target_id: destTarget.id,
        queue_ids: transferItemsWithReceipt.map((item) => item.id),
        commands: [],
        artifacts: [],
        summary: "session closeout apply transfer",
      });
    }

    const resultPayload: JsonObject = {
      schema_version: "session-closeout.apply.v1",
      origin,
      destination_target: destinationTarget,
      eligible_items: eligibility.eligible,
      ineligible_items: eligibility.ineligible,
      transfer_items: transferSummary,
      created_ids: created.map((item) => item.id),
      mapping,
      audit: auditEntries,
      evidence_added: evidenceAdded,
      telemetry_snapshot_ref: telemetryRef,
      gate_run_ref: plan.gate.path ?? null,
      force,
      receipt: {
        path: receiptRelPath,
        sha256: receiptHash,
      },
    };

    const artifact = await writeCloseoutArtifact({
      root: sourceTarget.root,
      storePath: sourceTarget.storePath,
      name: "closeout-apply.json",
      payload: resultPayload,
    });

    const receiptPayload: JsonObject = {
      schema_version: "session-closeout.receipt.v1",
      source: {
        repo_path: sourceTarget.root,
        origin,
      },
      mapping,
      closeout_apply_sha256: artifact.sha256,
    };
    await fs.mkdir(path.dirname(receiptAbsPath), { recursive: true });
    await fs.writeFile(
      receiptAbsPath,
      `${stableStringify(receiptPayload)}\n`,
      "utf8",
    );

    if (context.json) {
      writeJson({
        ok: true,
        result: resultPayload,
        artifact,
        sha256: artifact.sha256,
      });
    } else {
      writeLines([
        `closeout: applied (${created.length} drafts)`,
        `transfer: ${transferItemsWithReceipt.length} items`,
        `artifact: ${artifact.path}`,
        `sha256: ${artifact.sha256}`,
      ]);
    }
  } finally {
    await releaseWriteLock(destLockPath);
    await releaseWriteLock(lockPath);
  }
};
