export type GateShardSpec = {
  index: number;
  count: number;
};

import type { JsonValue } from "../../core/types.js";

export type GateShardPayload = {
  schema_version: "gate-shard.v1";
  shard: GateShardSpec;
  gate: {
    ok: boolean;
    mode: string;
    results: Array<{
      id: string;
      command: string;
      ok: boolean;
      exitCode: number;
      durationMs: number;
      started_at: string;
      ended_at: string;
      status: "ok" | "fail" | "skipped";
      skip_reason?: string;
      touched_files: string[];
      artifact: string | null;
      triage: JsonValue | null;
    }>;
    total_duration_ms: number;
    plan: JsonValue | null;
    preflight: JsonValue | null;
    overrides: JsonValue | null;
    artifacts: string[];
  };
};

export const parseGateShardSpec = (
  raw: string | boolean | undefined,
): GateShardSpec | null => {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) {
    throw new Error("Invalid --shard value. Use format K/N, e.g. 1/4.");
  }
  const normalized = String(raw).trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    throw new Error("Invalid --shard value. Use format K/N, e.g. 1/4.");
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new Error("Invalid --shard value. Use format K/N, e.g. 1/4.");
  }
  return { index, count };
};

const normalizeCommand = (gate: {
  id?: string;
  cmd?: string[];
  command?: string[];
}): string[] => {
  const raw = gate.cmd ?? gate.command ?? [];
  return raw.map((entry) => String(entry).toLowerCase());
};

export const isTestGate = (gate: {
  id?: string;
  cmd?: string[];
  command?: string[];
}): boolean => {
  if (typeof gate.id === "string" && gate.id.toLowerCase() === "test") {
    return true;
  }
  const cmd = normalizeCommand(gate);
  return cmd[0] === "npm" && cmd[1] === "run" && cmd[2] === "test";
};

export const shouldRunGateForShard = (
  gate: {
    id?: string;
    cmd?: string[];
    command?: string[];
  },
  shard: GateShardSpec | null,
  options?: { nonTestOnly?: boolean },
): boolean => {
  if (!shard) return true;
  if (options?.nonTestOnly) return !isTestGate(gate);
  return isTestGate(gate);
};

export const rewriteTestGateForShard = <
  T extends { cmd?: string[]; command?: string[] },
>(
  gate: T,
  shard: GateShardSpec | null,
): T => {
  const cmd = gate.cmd ?? gate.command;
  if (!cmd) return gate;
  const normalized = cmd.map((entry) => String(entry).toLowerCase());
  const isNpmTest = normalized[0] === "npm" && normalized[1] === "run" && normalized[2] === "test";
  if (!isNpmTest) return gate;
  const shardArg = shard ? [`--shard`, `${shard.index}/${shard.count}`] : [];
  return {
    ...gate,
    cmd: [
      "node",
      "scripts/parallel-runner.mjs",
      ...shardArg,
      "test/*.test.js",
      "test/holdout/*.test.js",
    ],
  };
};

export const computeShardBudget = ({
  remainingMs,
  safetyMs,
  minStartMs,
}: {
  remainingMs: number;
  safetyMs: number;
  minStartMs: number;
}): { canStart: boolean; timeoutMs: number; remainingMs: number } => {
  const remaining = Number.isFinite(remainingMs)
    ? Math.max(0, Math.floor(remainingMs))
    : 0;
  const safety = Number.isFinite(safetyMs)
    ? Math.max(0, Math.floor(safetyMs))
    : 0;
  const minStart = Number.isFinite(minStartMs)
    ? Math.max(0, Math.floor(minStartMs))
    : 0;
  if (remaining <= minStart) {
    return { canStart: false, timeoutMs: 0, remainingMs: remaining };
  }
  const timeoutMs = Math.max(0, remaining - safety);
  return { canStart: timeoutMs > 0, timeoutMs, remainingMs: remaining };
};

export const rewriteDeterminismGateForShard = <
  T extends { id?: string; cmd?: string[]; command?: string[] },
>(
  gate: T,
  options?: { nonTestOnly?: boolean; budgetMs?: number },
): T => {
  if (!options?.nonTestOnly) return gate;
  const cmd = gate.cmd ?? gate.command;
  if (!cmd) return gate;
  const id = typeof gate.id === "string" ? gate.id.toLowerCase() : "";
  const normalized = cmd.map((entry) => String(entry).toLowerCase());
  const isDeterminism =
    id === "determinism" || normalized.includes("scripts/check-determinism.mjs");
  if (!isDeterminism) return gate;
  if (normalized.includes("--mode")) return gate;
  const budgetMs =
    typeof options?.budgetMs === "number" && Number.isFinite(options.budgetMs)
      ? Math.max(0, Math.floor(options.budgetMs))
      : null;
  const extraArgs: string[] = ["--mode", "tsc"];
  if (budgetMs && budgetMs > 0 && !normalized.includes("--budget-ms")) {
    extraArgs.push("--budget-ms", String(budgetMs));
  }
  return {
    ...gate,
    cmd: [...cmd, ...extraArgs],
  };
};

export const rewriteGateForShard = <
  T extends { id?: string; cmd?: string[]; command?: string[] },
>(
  gate: T,
  shard: GateShardSpec | null,
  options?: { nonTestOnly?: boolean; budgetMs?: number },
): T => {
  const rewritten = rewriteTestGateForShard(gate, shard);
  return rewriteDeterminismGateForShard(rewritten, options);
};

export const formatShardLabel = (shard: GateShardSpec): string =>
  `${shard.index}-of-${shard.count}`;

export const normalizeShardResultId = (
  result: { id: string; command: string },
  shard: GateShardSpec | null,
): string => {
  const command = result.command.toLowerCase();
  const match = command.match(/--shard\s+(\d+\s*\/\s*\d+)/);
  let shardSpec: GateShardSpec | null = shard;
  if (match) {
    try {
      shardSpec = parseGateShardSpec(match[1]);
    } catch {
      shardSpec = shard;
    }
  }
  if (!shardSpec) return result.id;
  if (result.id.toLowerCase() === "test" || command.includes("npm run test")) {
    return `${result.id}#${formatShardLabel(shardSpec)}`;
  }
  return result.id;
};

export const deriveNonTestStatus = ({
  shard0,
  nonTestIds,
}: {
  shard0: GateShardPayload | null;
  nonTestIds?: string[];
}): {
  nonTestCompleted: string[];
  nonTestTotal: number;
  nonTestComplete: boolean;
} => {
  const results = shard0?.gate?.results ?? [];
  const candidateIds = (nonTestIds && nonTestIds.length)
    ? nonTestIds
    : results.map((result) => result.id).filter((id) => id !== "test");
  const completed = results
    .map((result) => result.id)
    .filter((id) => candidateIds.includes(id));
  const total = candidateIds.length;
  const complete = total === 0 ? true : completed.length === total;
  return { nonTestCompleted: completed, nonTestTotal: total, nonTestComplete: complete };
};

export const resolveNonTestStatus = ({
  shard0,
  nonTestIds,
  fallback,
}: {
  shard0: GateShardPayload | null;
  nonTestIds?: string[];
  fallback?: {
    nonTestCompleted?: string[];
    nonTestTotal?: number;
    nonTestComplete?: boolean;
  };
}): {
  nonTestCompleted: string[];
  nonTestTotal: number;
  nonTestComplete: boolean;
} => {
  if (shard0?.gate) {
    const args: { shard0: GateShardPayload | null; nonTestIds?: string[] } = {
      shard0,
    };
    if (nonTestIds) args.nonTestIds = nonTestIds;
    return deriveNonTestStatus(args);
  }
  const completed = Array.isArray(fallback?.nonTestCompleted)
    ? fallback?.nonTestCompleted.map((entry) => String(entry))
    : [];
  const total =
    typeof fallback?.nonTestTotal === "number"
      ? fallback?.nonTestTotal
      : nonTestIds?.length ?? 0;
  const complete =
    typeof fallback?.nonTestComplete === "boolean"
      ? fallback?.nonTestComplete
      : total === 0
        ? true
        : completed.length === total;
  return { nonTestCompleted: completed, nonTestTotal: total, nonTestComplete: complete };
};

export const listPendingShards = ({
  count,
  completed,
  startIndex = 1,
}: {
  count: number;
  completed: number[];
  startIndex?: number;
}): number[] => {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!total) return [];
  const start = Math.max(1, Math.min(total, Math.floor(startIndex)));
  const done = new Set(
    completed
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.floor(value))
      .filter((value) => value >= 1 && value <= total),
  );
  const pending: number[] = [];
  for (let i = start; i <= total; i += 1) {
    if (!done.has(i)) pending.push(i);
  }
  return pending;
};

export const selectShardBatch = ({
  count,
  completed,
  startIndex = 1,
  batchSize,
}: {
  count: number;
  completed: number[];
  startIndex?: number;
  batchSize: number;
}): { pending: number[]; selected: number[] } => {
  const pending = listPendingShards({ count, completed, startIndex });
  const size = Number.isFinite(batchSize) ? Math.max(0, Math.floor(batchSize)) : 0;
  if (!size) return { pending, selected: [] };
  return { pending, selected: pending.slice(0, size) };
};

export const assembleGateShardPayloads = (
  payloads: GateShardPayload[],
): GateShardPayload["gate"] => {
  if (!payloads.length) {
    return {
      ok: false,
      mode: "full",
      results: [],
      total_duration_ms: 0,
      plan: null,
      preflight: null,
      overrides: null,
      artifacts: [],
    };
  }
  const sorted = [...payloads].sort(
    (a, b) => a.shard.index - b.shard.index,
  );
  const base = sorted[0];
  if (!base) {
    return {
      ok: false,
      mode: "full",
      results: [],
      total_duration_ms: 0,
      plan: null,
      preflight: null,
      overrides: null,
      artifacts: [],
    };
  }
  const seen = new Set<string>();
  const results: GateShardPayload["gate"]["results"] = [];
  for (const payload of sorted) {
    for (const result of payload.gate.results ?? []) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      results.push(result);
    }
  }
  const artifacts = new Set<string>();
  for (const payload of sorted) {
    for (const artifact of payload.gate.artifacts ?? []) {
      artifacts.add(String(artifact));
    }
  }
  const totalDuration = sorted.reduce((sum, payload) => {
    const duration = Number(payload.gate.total_duration_ms ?? 0);
    return sum + (Number.isFinite(duration) ? duration : 0);
  }, 0);
  const ok =
    sorted.every((payload) => Boolean(payload.gate.ok)) &&
    results.every((result) => result.ok !== false);

  return {
    ok,
    mode: base.gate.mode,
    results,
    total_duration_ms: totalDuration,
    plan: base.gate.plan ?? null,
    preflight: base.gate.preflight ?? null,
    overrides: base.gate.overrides ?? null,
    artifacts: Array.from(artifacts).sort(),
  };
};

export const mergeGateShardResults = (
  payloads: GateShardPayload["gate"][],
  order: string[],
): GateShardPayload["gate"] => {
  if (!payloads.length) {
    return {
      ok: false,
      mode: "full",
      results: [],
      total_duration_ms: 0,
      plan: null,
      preflight: null,
      overrides: null,
      artifacts: [],
    };
  }
  const orderIndex = new Map(order.map((id, idx) => [id, idx]));
  const merged = new Map<string, GateShardPayload["gate"]["results"][number]>();
  const artifacts = new Set<string>();
  let totalDuration = 0;
  let mode: string | null = null;
  let plan: JsonValue | null = null;
  let preflight: JsonValue | null = null;
  let overrides: JsonValue | null = null;
  let ok = true;

  for (const payload of payloads) {
    mode = mode ?? payload.mode;
    plan = plan ?? payload.plan ?? null;
    preflight = preflight ?? payload.preflight ?? null;
    overrides = overrides ?? payload.overrides ?? null;
    totalDuration += Number(payload.total_duration_ms ?? 0) || 0;
    ok = ok && Boolean(payload.ok);
    for (const result of payload.results ?? []) {
      merged.set(result.id, result);
    }
    for (const artifact of payload.artifacts ?? []) {
      artifacts.add(String(artifact));
    }
  }

  const ordered = Array.from(merged.values()).sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.POSITIVE_INFINITY;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return String(a.id).localeCompare(String(b.id));
  });

  ok = ok && ordered.every((result) => result.ok !== false);

  return {
    ok,
    mode: mode ?? "full",
    results: ordered,
    total_duration_ms: totalDuration,
    plan,
    preflight,
    overrides,
    artifacts: Array.from(artifacts).sort(),
  };
};
