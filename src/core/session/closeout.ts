import path from "node:path";

import { readJson } from "../fs.js";
import { normalizeDeps, normalizeEvidence, normalizeTags, parseTargetInput } from "../queue/transitions.js";
import { nextQueueId } from "../queue/store.js";
import type { QueueItem, QueueSpec } from "../types.js";

type GateFailure = {
  id: string;
  command: string | null;
  status: string | null;
};

export type CloseoutDraft = {
  title: string;
  type: QueueItem["type"];
  priority: QueueItem["priority"];
  target: string;
  spec: QueueSpec;
  tags: string[];
  deps: string[];
  evidence: string[];
  notes: string;
};

export type CloseoutPlan = {
  schema_version: "session-closeout.v1";
  contracts_consulted: string[];
  gate: {
    path: string | null;
    failures: GateFailure[];
  };
  drafts: CloseoutDraft[];
  limits: {
    max_drafts: number;
  };
  warnings: string[];
};

const CONTRACT_REFS = ["6.2"];
const DEFAULT_TARGET = "range:0.1.x";
const MAX_DRAFTS = 5;
const GATE_INPUT_EVIDENCE = "output:.ato/runs/runs.jsonl";

const resolveInRepoPath = (root: string, filePath: string): string | null => {
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
};

const normalizeGateFailures = (payload: unknown): GateFailure[] => {
  if (!payload || typeof payload !== "object") return [];
  const results = Array.isArray((payload as { results?: unknown }).results)
    ? (payload as { results: unknown[] }).results
    : [];
  const failures = results
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const result = entry as Record<string, unknown>;
      const ok = result["ok"];
      const status =
        typeof result["status"] === "string" ? result["status"] : null;
      if (ok !== false && status !== "fail") return null;
      const id =
        typeof result["id"] === "string" && result["id"].trim()
          ? result["id"].trim()
          : `step-${index + 1}`;
      const command =
        typeof result["command"] === "string" && result["command"].trim()
          ? result["command"].trim()
          : null;
      return { id, command, status };
    })
    .filter((entry): entry is GateFailure => Boolean(entry));
  failures.sort((a, b) => {
    const idDiff = a.id.localeCompare(b.id);
    if (idDiff !== 0) return idDiff;
    return String(a.command ?? "").localeCompare(String(b.command ?? ""));
  });
  return failures;
};

const buildDrafts = ({
  failures,
  gateEvidence,
  maxDrafts,
}: {
  failures: GateFailure[];
  gateEvidence: string[];
  maxDrafts: number;
}): CloseoutDraft[] => {
  if (!failures.length) return [];
  return failures.slice(0, maxDrafts).map((failure) => {
    const title = `Resolve gate failure: ${failure.id}`;
    const problem = `Gate step ${failure.id} failed in the latest run.`;
    const outcome = `Gate step ${failure.id} passes without regressions.`;
    const plan = {
      steps: [
        "Reproduce the gate failure",
        "Apply the fix",
        "Run gate checks",
      ],
    };
    const acceptance_criteria = [
      "cmd:node dist/cli/main.js gate run --mode full --json",
      GATE_INPUT_EVIDENCE,
    ];
    const inputs = gateEvidence.length ? gateEvidence : [GATE_INPUT_EVIDENCE];
    const spec: QueueSpec = {
      problem,
      outcome,
      plan,
      acceptance_criteria,
      inputs,
      deliverables: ["gate-failure-fix"],
      scope: ["src/**"],
      risks: [],
      contract_refs: [...CONTRACT_REFS],
      runbook: [],
    };
    return {
      title,
      type: "feature",
      priority: "P1",
      target: DEFAULT_TARGET,
      spec,
      tags: [],
      deps: [],
      evidence: [],
      notes: "",
    };
  });
};

export const buildCloseoutPlan = async ({
  root,
  gateRunPath,
  maxDrafts = MAX_DRAFTS,
}: {
  root: string;
  gateRunPath: string | null;
  maxDrafts?: number;
}): Promise<CloseoutPlan> => {
  const warnings: string[] = [];
  let gatePath: string | null = null;
  let gateFailures: GateFailure[] = [];
  const gateEvidence: string[] = [GATE_INPUT_EVIDENCE];

  if (gateRunPath) {
    const resolved = path.isAbsolute(gateRunPath)
      ? gateRunPath
      : path.resolve(root, gateRunPath);
    const relPath = resolveInRepoPath(root, resolved);
    if (relPath) {
      gatePath = relPath;
      gateEvidence.push(`file:${relPath}`);
    } else {
      warnings.push("gate_run_path_outside_repo");
    }
    const payload = await readJson<Record<string, unknown>>(resolved, null);
    if (payload) {
      gateFailures = normalizeGateFailures(payload);
    } else {
      warnings.push("gate_run_not_found");
    }
  }

  const drafts = buildDrafts({
    failures: gateFailures,
    gateEvidence,
    maxDrafts,
  });

  return {
    schema_version: "session-closeout.v1",
    contracts_consulted: [...CONTRACT_REFS],
    gate: {
      path: gatePath,
      failures: gateFailures,
    },
    drafts,
    limits: {
      max_drafts: maxDrafts,
    },
    warnings,
  };
};

export const buildQueueItemsFromDrafts = ({
  drafts,
  existingItems,
  timestamp,
}: {
  drafts: CloseoutDraft[];
  existingItems: QueueItem[];
  timestamp: string;
}): { created: QueueItem[]; nextItems: QueueItem[] } => {
  const created: QueueItem[] = [];
  let items = [...existingItems];
  for (const draft of drafts) {
    const newId = nextQueueId(items);
    const item: QueueItem = {
      id: newId,
      title: draft.title,
      type: draft.type,
      status: "queued",
      priority: draft.priority,
      tags: normalizeTags(draft.tags),
      created_at: timestamp,
      updated_at: timestamp,
      target: parseTargetInput(draft.target),
      deps: normalizeDeps(draft.deps),
      evidence: normalizeEvidence(draft.evidence),
      owner: "agent",
      notes: draft.notes,
      spec: draft.spec,
    };
    items = [...items, item];
    created.push(item);
  }
  return { created, nextItems: items };
};
