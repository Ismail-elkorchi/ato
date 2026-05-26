import crypto from "node:crypto";

import { readQueueItems } from "../queue/store.js";
import { depsSatisfied } from "../queue/ordering.js";
import { normalizeEvidence } from "../queue/transitions.js";
import { nextCycleIdentity } from "./store.js";
import { loadBlockConfig, resolveBlockState } from "../blocks/config.js";
import type { CycleSelectionEvidence, QueueItem } from "../types.js";

type CycleSelectionScope = "block" | "global";

type CycleSelectionPolicy = {
  seedSource: string;
  seedValue: string;
  scope: CycleSelectionScope;
  blockId?: string;
  source: "block" | "default";
};

export type CycleSelection = {
  cycle_id: string;
  cycle_index: number;
  scope: CycleSelectionScope;
  policy_source: "block" | "default";
  seed: { source: string; value: string; block_id?: string | null };
  rationale: {
    seed: string;
    pool_ids: string[];
    chosen_id: string;
    rule: string;
    hash: string;
  } | null;
  candidates: { total: number; eligible: number };
  excluded_by_reason: {
    out_of_scope: number;
    status: number;
    deps: number;
    missing_evidence: number;
  };
  selection: { queue_id: string; hash: string } | null;
};

export const buildCycleSelectionEvidence = ({
  selection,
}: {
  selection: CycleSelection;
}): CycleSelectionEvidence => ({
  mode: "queue",
  cycle_id: selection.cycle_id,
  cycle_index: selection.cycle_index,
  scope: selection.scope,
  seed: selection.seed,
  candidates: selection.candidates,
  excluded_by_reason: selection.excluded_by_reason,
  rationale: selection.rationale,
  selection: selection.selection,
});

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const resolveCycleSelectionPolicy = async ({
  store,
  targetId,
  blockId,
}: {
  store: string;
  targetId: string;
  blockId?: string | null;
}): Promise<CycleSelectionPolicy> => {
  const blockState = await resolveBlockState(store);
  const blockIdCandidate =
    typeof blockId === "string" && blockId
      ? blockId
      : blockState.active_block_id ?? "";
  const block = blockIdCandidate
    ? await loadBlockConfig(store, blockIdCandidate)
    : null;
  const blockObj = asObject(block);
  const blockIdResolved =
    typeof blockObj?.["blockId"] === "string"
      ? String(blockObj["blockId"])
      : blockIdCandidate;

  const policy: CycleSelectionPolicy = {
    seedSource: blockIdResolved ? "blockId" : "targetId",
    seedValue: blockIdResolved || targetId || "default",
    scope: blockIdResolved ? "block" : "global",
    source: blockObj ? "block" : "default",
  };
  if (blockIdResolved) {
    policy.blockId = blockIdResolved;
  }
  return policy;
};

const hasEvidence = (item: QueueItem): boolean => {
  const evidence = normalizeEvidence(item.evidence ?? []);
  const inputs = normalizeEvidence(item.spec?.inputs ?? []);
  return evidence.length + inputs.length > 0;
};

const BLOCK_TITLE_RE = /\bblock-(\d{4,})\b/i;

const inferBlockIdFromTitle = (title: string): string | null => {
  const match = title.match(BLOCK_TITLE_RE);
  if (!match) return null;
  return `block-${match[1]}`.toLowerCase();
};

const isBlockScopedItem = (
  item: QueueItem,
  blockId: string | undefined,
): boolean => {
  if (!blockId) return false;
  const normalized = blockId.toLowerCase();
  const inferred = inferBlockIdFromTitle(item.title ?? "");
  if (inferred === normalized) return true;
  if (String(item.target?.value ?? "").toLowerCase() === normalized) return true;
  return (item.tags ?? []).some((tag) => String(tag).toLowerCase() === normalized);
};

export const selectCycleCandidate = ({
  seed,
  poolIds,
}: {
  seed: string;
  poolIds: string[];
}): {
  seed: string;
  pool_ids: string[];
  chosen_id: string;
  rule: string;
  hash: string;
} | null => {
  const pool = poolIds.map((id) => String(id)).filter(Boolean);
  const poolIdsSorted = [...new Set(pool)].sort((a, b) => a.localeCompare(b));
  if (!poolIdsSorted.length) return null;
  const hashed = poolIdsSorted.map((id) => ({
    id,
    hash: crypto.createHash("sha256").update(`${seed}:${id}`).digest("hex"),
  }));
  hashed.sort((a, b) => {
    const hashDiff = a.hash.localeCompare(b.hash);
    if (hashDiff !== 0) return hashDiff;
    return a.id.localeCompare(b.id);
  });
  const selected = hashed[0];
  if (!selected) return null;
  return {
    seed,
    pool_ids: poolIdsSorted,
    chosen_id: selected.id,
    rule: "min sha256(seed:id) over pool_ids sorted asc",
    hash: selected.hash,
  };
};

export const selectCycleQueueItem = async ({
  store,
  targetId,
  blockId,
  cycleId,
  cycleIndex,
}: {
  store: string;
  targetId: string;
  blockId?: string | null;
  cycleId?: string;
  cycleIndex?: number;
}): Promise<CycleSelection> => {
  const identity =
    cycleId && Number.isFinite(cycleIndex) && Number(cycleIndex) > 0
      ? { id: cycleId, index: Number(cycleIndex) }
      : await nextCycleIdentity(store);
  const policy = await resolveCycleSelectionPolicy({
    store,
    targetId,
    ...(blockId !== undefined ? { blockId } : {}),
  });

  const queueRecords = await readQueueItems(store);
  const items = queueRecords.map((record) => record.item);
  const statusMap = new Map(items.map((item) => [item.id, item.status]));
  const scopedItems =
    policy.scope === "block"
      ? items.filter((item) => isBlockScopedItem(item, policy.blockId))
      : items;
  const outOfScope = items.length - scopedItems.length;
  const statusEligible = scopedItems.filter((item) =>
    ["active", "queued"].includes(item.status),
  );
  const statusExcluded = scopedItems.length - statusEligible.length;
  const depsEligible = statusEligible.filter((item) =>
    depsSatisfied(item, statusMap),
  );
  const depsExcluded = statusEligible.length - depsEligible.length;
  const evidenceEligible = depsEligible.filter((item) => hasEvidence(item));
  const missingEvidence = depsEligible.length - evidenceEligible.length;
  const eligible = evidenceEligible.sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );

  const poolIds = eligible.map((item) => item.id);
  const rationale = selectCycleCandidate({
    seed: policy.seedValue,
    poolIds,
  });

  const excludedByReason = {
    out_of_scope: outOfScope,
    status: statusExcluded,
    deps: depsExcluded,
    missing_evidence: missingEvidence,
  };

  if (!rationale) {
    const error = new Error(
      "No eligible evidence-backed queue items available for cycle selection.",
    );
    (error as Error & { code?: number; details?: unknown }).code = 3;
    (error as Error & { details?: unknown }).details = {
      cycle_id: identity.id,
      cycle_index: identity.index,
      scope: policy.scope,
      candidates_total: scopedItems.length,
      candidates_eligible: eligible.length,
      excluded_by_reason: excludedByReason,
      policy_source: policy.source,
      block_id: policy.blockId ?? null,
    };
    throw error;
  }

  return {
    cycle_id: identity.id,
    cycle_index: identity.index,
    scope: policy.scope,
    policy_source: policy.source,
    seed: {
      source: policy.seedSource,
      value: policy.seedValue,
      block_id: policy.blockId ?? null,
    },
    candidates: {
      total: scopedItems.length,
      eligible: eligible.length,
    },
    excluded_by_reason: excludedByReason,
    rationale,
    selection: { queue_id: rationale.chosen_id, hash: rationale.hash },
  };
};
