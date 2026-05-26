import {
  normalizeDeps,
  normalizeEvidence,
  normalizeTags,
  parseTargetInput,
} from "./transitions.js";
import type {
  QueueItem,
  QueueOrigin,
  QueueSpec,
  QueueTarget,
  TargetSelector,
} from "../types.js";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry)))
    .filter((entry) => entry.length > 0);
};

const toSelector = (value: string): TargetSelector | null => {
  if (
    value === "exact" ||
    value === "range" ||
    value === "milestone" ||
    value === "unbounded"
  ) {
    return value;
  }
  return null;
};

const normalizeTargetInput = (value: unknown): QueueTarget => {
  if (typeof value === "string") {
    return parseTargetInput(value.trim());
  }
  const record = asRecord(value);
  if (record) {
    const selector = toSelector(asString(record["selector"]));
    const kind = toSelector(asString(record["kind"]));
    const target: QueueTarget = {};
    if (selector) target.selector = selector;
    if (kind) target.kind = kind;
    if (typeof record["value"] === "string") {
      target.value = String(record["value"]);
    }
    if (target.selector || target.kind) {
      return target;
    }
  }
  return parseTargetInput("unbounded");
};

const normalizeContractRefs = (value: unknown): QueueSpec["contract_refs"] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => entry) as QueueSpec["contract_refs"];
};

const normalizeOrigin = (value: unknown): QueueOrigin | null => {
  const record = asRecord(value);
  if (!record) return null;
  const commit = asString(record["commit"]);
  if (!commit) return null;
  const repoRemote = asString(record["repo_remote"]);
  const repoPath = asString(record["repo_path"]);
  if (!repoRemote && !repoPath) return null;
  const origin: QueueOrigin = { commit };
  if (repoRemote) {
    origin.repo_remote = repoRemote;
  } else if (repoPath) {
    origin.repo_path = repoPath;
  }
  const subpath = asString(record["subpath"]);
  if (subpath) origin.subpath = subpath;
  const createdBy = asString(record["created_by"]);
  if (createdBy) origin.created_by = createdBy;
  return origin;
};

export const buildIntakeItem = ({
  candidate,
  id,
  sourceRepo,
  ingestedAt,
  telemetryRef,
  originFallback,
}: {
  candidate: unknown;
  id: string;
  sourceRepo: string;
  ingestedAt: string;
  telemetryRef?: string | null;
  originFallback?: QueueOrigin | null;
}): QueueItem => {
  const source = asRecord(candidate) ?? {};
  const specSource = asRecord(source["spec"]);
  const detailsSource = asRecord(source["details"]);
  const originCandidate = normalizeOrigin(source["origin"]);
  const origin = originCandidate ?? originFallback ?? null;
  const planSource = asRecord(specSource?.["plan"]);
  const planSteps = asStringArray(planSource?.["steps"]);
  const planRationale = asString(planSource?.["rationale"]);

  const spec: QueueSpec = {
    problem: asString(specSource?.["problem"]),
    outcome: asString(specSource?.["outcome"]),
    plan: {
      steps: planSteps,
      ...(planRationale ? { rationale: planRationale } : {}),
    },
    acceptance_criteria: asStringArray(specSource?.["acceptance_criteria"]),
    inputs: asStringArray(specSource?.["inputs"]),
    deliverables: asStringArray(specSource?.["deliverables"]),
    scope: asStringArray(specSource?.["scope"]),
    risks: asStringArray(specSource?.["risks"]),
    contract_refs: normalizeContractRefs(specSource?.["contract_refs"]),
    runbook: asStringArray(specSource?.["runbook"]),
  };

  const target = normalizeTargetInput(source["target"]);
  const evidence = normalizeEvidence(asStringArray(source["evidence"]));
  const deps = normalizeDeps(asStringArray(source["deps"]));
  const tags = normalizeTags(asStringArray(source["tags"]));

  const auditParts = [`source_repo=${sourceRepo}`, `ingested_at=${ingestedAt}`];
  if (telemetryRef) {
    auditParts.push(`telemetry_ref=${telemetryRef}`);
  }
  const auditLine = `Intake: ${auditParts.join("; ")}`;
  const baseNotes = asString(source["notes"]);
  const notes = baseNotes ? `${baseNotes}\n${auditLine}` : auditLine;

  const item: QueueItem = {
    id,
    title: asString(source["title"]),
    type: (asString(source["type"]) || "feature") as QueueItem["type"],
    status: "queued",
    priority: (source["priority"] ?? "P2") as QueueItem["priority"],
    tags,
    created_at: ingestedAt,
    updated_at: ingestedAt,
    target,
    deps,
    evidence,
    owner: asString(source["owner"]) || "agent",
    notes,
    spec,
    ...(detailsSource ? { details: detailsSource } : {}),
    ...(origin ? { origin } : {}),
  };

  return item;
};
