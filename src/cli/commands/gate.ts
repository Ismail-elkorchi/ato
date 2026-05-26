import path from "node:path";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  listGateCommands,
  runGates,
  runGateSelection,
  buildGatePlan,
} from "../../core/gates/runner.js";
import { resolveGateConfig } from "../../core/gates/overrides.js";
import { recommendGateMode } from "../../core/gates/recommend.js";
import { resolveGateEnv } from "../../core/gates/env.js";
import { runPluginHooks } from "../../core/plugins/runner.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { readState } from "../../core/state.js";
import { writeJson as writeJsonFile, readJson } from "../../core/fs.js";
import type { JsonValue } from "../../core/types.js";
import {
  assembleGateShardPayloads,
  computeShardBudget,
  deriveNonTestStatus,
  resolveNonTestStatus,
  formatShardLabel,
  isTestGate,
  mergeGateShardResults,
  normalizeShardResultId,
  parseGateShardSpec,
  rewriteGateForShard,
  selectShardBatch,
  shouldRunGateForShard,
  type GateShardPayload,
  type GateShardSpec,
} from "./gate-shard.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato gate run|retry|explain",
  "",
  "Options:",
  "  --shard K/N   Run a deterministic shard of full gate tests",
  "  --non-test   Run non-test gate steps only (requires --shard)",
  "  --non-test-budget-ms <ms>  Budget for non-test steps (default 9000)",
  "  --shard-batch <n>  Run up to N pending test shards in one invocation",
  "  --shard-budget-ms <ms>  Budget for shard batches (default 9000)",
].join("\n");
const HELP_TOKENS = new Set(["help", "-h", "--help"]);
const SHARD_TIMEOUT_SAFETY_MS = 100;
const SHARD_MIN_START_MS = 500;
const SHARD_RESUME_BUDGET_MS = 3000;

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const toSafeRelativePath = (root: string, filePath: string): string => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel === "." || rel.startsWith("..")) return "<redacted>";
  return toPosixPath(rel);
};

const formatShardBatchResume = (
  shard: GateShardSpec,
  batchSize: number,
  shardBudgetValue: number,
): string => {
  const resumeBudget =
    Number.isFinite(shardBudgetValue) && shardBudgetValue > 0
      ? Math.floor(shardBudgetValue)
      : SHARD_RESUME_BUDGET_MS;
  return `ato gate run --mode full --json --shard ${shard.index}/${shard.count} --shard-batch ${batchSize} --shard-budget-ms ${resumeBudget}`;
};

const normalizeArtifactPath = (root: string, value: string | null): string | null => {
  if (!value) return null;
  return toSafeRelativePath(root, value);
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

const normalizeArtifacts = (root: string, artifacts: string[]): string[] => {
  const normalized = artifacts
    .map((artifact) => normalizeArtifactPath(root, artifact))
    .filter((artifact): artifact is string => Boolean(artifact));
  return Array.from(new Set(normalized)).sort();
};

const getPreflightWarning = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const warning = (value as { warning?: unknown }).warning;
  return typeof warning === "string" ? warning : null;
};

const getTriageSummary = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : null;
};

const getGatePlanGateIds = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const gates = (value as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return [];
  const ids: string[] = [];
  for (const entry of gates) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
};

const collectShardFiles = async (
  dir: string,
  count: number,
): Promise<Array<{ index: number; path: string }>> => {
  const entries = await fs.readdir(dir).catch(() => []);
  const results: Array<{ index: number; path: string }> = [];
  const pattern = /^gate-full\.shard-(\d+)-of-(\d+)\.json$/;
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (!match) continue;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isInteger(index) || !Number.isInteger(total)) continue;
    if (total !== count) continue;
    results.push({ index, path: path.join(dir, entry) });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
};

export const runGateCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  type GateRunResult = Awaited<ReturnType<typeof runGates>>;
  const json = context.json;
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"] || HELP_TOKENS.has(subcommand)) {
    writeLines([HELP]);
    return;
  }

  const parseHeartbeat = (
    value: string | boolean | undefined,
    options: { defaultEnabled: boolean },
  ): { enabled: boolean; heartbeatMs: number; heartbeatTicks: number } => {
    if (value === false) {
      return { enabled: false, heartbeatMs: 0, heartbeatTicks: 0 };
    }
    if (value === undefined && !options.defaultEnabled) {
      return { enabled: false, heartbeatMs: 0, heartbeatTicks: 0 };
    }
    let seconds = 10;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Invalid --heartbeat value. Use a positive number.");
      }
      seconds = parsed;
    }
    const ticksRaw = Number(process.env["ATO_GATE_HEARTBEAT_TICKS"]);
    const heartbeatTicks = Number.isFinite(ticksRaw) && ticksRaw > 0 ? ticksRaw : 0;
    return {
      enabled: true,
      heartbeatMs: heartbeatTicks ? 0 : Math.round(seconds * 1000),
      heartbeatTicks,
    };
  };

  const parsePositiveInt = (
    value: string | boolean | undefined,
    label: string,
  ): number | null => {
    if (value === undefined) return null;
    if (value === false) return null;
    if (value === true) {
      throw new Error(`Invalid ${label} value. Use a positive integer.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(`Invalid ${label} value. Use a positive integer.`);
    }
    return parsed;
  };

  const parseNonNegativeInt = (
    value: string | boolean | undefined,
    label: string,
  ): number | null => {
    if (value === undefined) return null;
    if (value === false) return null;
    if (value === true) {
      throw new Error(`Invalid ${label} value. Use a non-negative integer.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new Error(`Invalid ${label} value. Use a non-negative integer.`);
    }
    return parsed;
  };

  const createProgressReporter = ({
    heartbeat,
  }: {
    heartbeat: { enabled: boolean; heartbeatMs: number; heartbeatTicks: number };
  }) => ({
    onEvent: (event: {
      type: string;
      id: string;
      ok?: boolean;
    }) => {
      if (event.type === "step_start") {
        process.stdout.write(`[gate] start ${event.id}\n`);
      } else if (event.type === "step_end") {
        process.stdout.write(
          `[gate] end ${event.id} (${event.ok ? "ok" : "fail"})\n`,
        );
      } else if (event.type === "heartbeat") {
        process.stdout.write(`[gate] heartbeat ${event.id}\n`);
      }
    },
    ...(heartbeat.enabled
      ? {
          heartbeatMs: heartbeat.heartbeatMs,
          heartbeatTicks: heartbeat.heartbeatTicks,
        }
      : {}),
  });

  if (subcommand === "explain") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const resolved = resolveGateConfig({ config: target.config, targetId: target.id });
    const gates = resolved.effective ?? {};
    const payload = {
      ok: true,
      target: { id: target.id, root: target.root },
      fast: gates.fast ?? [],
      full: gates.full ?? {},
      scopeMap: gates.scopeMap ?? [],
      overrides: resolved.overrides,
      base: resolved.base,
    };

    if (json) {
      writeJson(payload);
    } else {
      const lines = ["gate config:"];
      lines.push("fast:");
      for (const gate of payload.fast) {
        lines.push(`- ${gate.id}: ${gate.cmd?.join(" ")}`);
      }
      lines.push("full tests:");
      const tests = payload.full.tests ?? {};
      for (const gate of tests.root ?? []) {
        lines.push(`- root: ${gate.id}: ${gate.cmd?.join(" ")}`);
      }
      for (const [scope, list] of Object.entries(tests.scopes ?? {})) {
        for (const gate of list) {
          lines.push(`- ${scope}: ${gate.id}: ${gate.cmd?.join(" ")}`);
        }
      }
      writeLines(lines);
    }
    return;
  }

  if (subcommand === "run") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

    try {
      const recommendation = await recommendGateMode({ root: target.root });
      const shard = parseGateShardSpec(flags["shard"]);
      const nonTestOnly = Boolean(flags["non-test"]);
      const nonTestBudgetRaw = flags["non-test-budget-ms"];
      const nonTestBudgetMs =
        typeof nonTestBudgetRaw === "string" && nonTestBudgetRaw.trim()
          ? Number(nonTestBudgetRaw)
          : 9000;
      const nonTestBudgetValue =
        Number.isFinite(nonTestBudgetMs) && nonTestBudgetMs > 0
          ? Math.floor(nonTestBudgetMs)
          : 9000;
      const shardBatchSize = parsePositiveInt(flags["shard-batch"], "--shard-batch") ?? 1;
      const shardBudgetValue =
        parseNonNegativeInt(flags["shard-budget-ms"], "--shard-budget-ms") ?? 9000;
      if (nonTestOnly && !shard) {
        throw new Error("--non-test requires --shard K/N.");
      }
      if (shardBatchSize > 1 && !shard) {
        throw new Error("--shard-batch requires --shard K/N.");
      }
      if (nonTestOnly && shardBatchSize > 1) {
        throw new Error("--non-test cannot be combined with --shard-batch.");
      }
      const requestedMode =
        typeof flags["mode"] === "string" ? flags["mode"] : null;
      const mode = requestedMode ?? recommendation.mode;
      if (!["fast", "full"].includes(mode)) {
        throw new Error(`Invalid --mode '${mode}'. Use 'fast' or 'full'.`);
      }
      const overridden = Boolean(requestedMode && requestedMode !== recommendation.mode);
      const explain = Boolean(flags["explain"]);
      const reportTouched = Boolean(flags["report-touched"]);
      const noBrowser = Boolean(flags["no-browser"]);
      const heartbeat = parseHeartbeat(flags["heartbeat"], {
        defaultEnabled: process.stdout.isTTY !== true,
      });
      const progress = !json ? createProgressReporter({ heartbeat }) : null;
      const artifactsDir = getArtifactsDir(target.storePath, null, "gate");
      const state = shard ? await readState(target.storePath) : null;
      const cycleId = state?.activeCycleId ?? null;
      const shardDir = shard
        ? cycleId
          ? path.join(target.storePath, "cycles", cycleId)
          : path.join(target.storePath, "gates")
        : null;
      const progressPath = shardDir
        ? path.join(shardDir, "gate-progress.json")
        : null;
      const nonTestPath = shardDir && shard
        ? path.join(shardDir, `gate-full.shard-0-of-${shard.count}.json`)
        : null;
      const existingProgress = progressPath
        ? await readJson<Record<string, unknown>>(progressPath, null)
        : null;
      const completedFromProgress = Array.isArray(
        existingProgress?.["completed"],
      )
        ? (existingProgress?.["completed"] as unknown[])
            .filter((value) => Number.isFinite(value))
            .map((value) => Math.floor(value as number))
        : [];
      const existingNonTest = nonTestPath
        ? await readJson<GateShardPayload>(nonTestPath, null)
        : null;
      const existingNonTestResults = new Set(
        existingNonTest?.gate?.results?.map((result) => result.id) ?? [],
      );
      const progressCarry = (() => {
        if (!existingProgress || typeof existingProgress !== "object" || Array.isArray(existingProgress)) {
          return {};
        }
        const record = existingProgress as Record<string, unknown>;
        const carried: Record<string, unknown> = {};
        if (typeof record["non_test_complete"] === "boolean") {
          carried["non_test_complete"] = record["non_test_complete"];
        }
        if (Array.isArray(record["non_test_completed"])) {
          carried["non_test_completed"] = record["non_test_completed"];
        }
        if (typeof record["non_test_present"] === "boolean") {
          carried["non_test_present"] = record["non_test_present"];
        }
        if (typeof record["non_test_total"] === "number") {
          carried["non_test_total"] = record["non_test_total"];
        }
        if (typeof record["non_test_path"] === "string") {
          carried["non_test_path"] = record["non_test_path"];
        }
        if (typeof record["gate_full_path"] === "string") {
          carried["gate_full_path"] = record["gate_full_path"];
        }
        if (Array.isArray(record["shard_outputs"])) {
          carried["shard_outputs"] = record["shard_outputs"];
        }
        if (existingNonTest?.gate?.results?.length) {
          const { nonTestCompleted, nonTestTotal, nonTestComplete } = deriveNonTestStatus({
            shard0: existingNonTest,
          });
          carried["non_test_present"] = true;
          carried["non_test_completed"] = nonTestCompleted;
          carried["non_test_total"] = nonTestTotal;
          carried["non_test_complete"] = nonTestComplete;
        }
        return carried;
      })();
      const env = {
        ...resolveGateEnv(target.root),
        ...(shard && !nonTestOnly
          ? { ATO_TEST_SHARD: `${shard.index}/${shard.count}` }
          : {}),
      };

      const normalizeGateResults = (
        gateResult: GateRunResult,
        shardSpec: GateShardSpec | null,
      ): GateShardPayload["gate"]["results"] =>
        gateResult.results.map((result) => ({
          ...result,
          id: normalizeShardResultId(result, shardSpec),
          artifact: normalizeArtifactPath(target.root, result.artifact),
          triage: toJsonValue(result.triage, target.root),
        }));

      const recordShardOutputs = async ({
        shardSpec,
        gateResult,
        normalizedResults,
        existingNonTestGate,
        nonTestOnly: recordNonTestOnly,
      }: {
        shardSpec: GateShardSpec;
        gateResult: GateRunResult;
        normalizedResults: GateShardPayload["gate"]["results"];
        existingNonTestGate: GateShardPayload | null;
        nonTestOnly: boolean;
      }): Promise<void> => {
        const shardLabel = recordNonTestOnly
          ? `0-of-${shardSpec.count}`
          : formatShardLabel(shardSpec);
        const resolvedShardDir = shardDir
          ? shardDir
          : cycleId
            ? path.join(target.storePath, "cycles", cycleId)
            : path.join(target.storePath, "gates");
        const shardPath = path.join(
          resolvedShardDir,
          `gate-full.shard-${shardLabel}.json`,
        );
        const localNonTestPath = path.join(
          resolvedShardDir,
          `gate-full.shard-0-of-${shardSpec.count}.json`,
        );
        const gateFullPath = path.join(resolvedShardDir, "gate-full.json");
        const shardPayloadShard = recordNonTestOnly
          ? { index: 0, count: shardSpec.count }
          : shardSpec;
        let shardPayload: GateShardPayload = {
          schema_version: "gate-shard.v1",
          shard: shardPayloadShard,
          gate: {
            ok: gateResult.ok,
            mode,
            results: normalizedResults,
            total_duration_ms: gateResult.totalDurationMs,
            plan: toJsonValue(gateResult.plan, target.root),
            preflight: toJsonValue(gateResult.preflight, target.root),
            overrides: toJsonValue(gateResult.overrides, target.root),
            artifacts: normalizeArtifacts(
              target.root,
              gateResult.artifacts ?? [],
            ),
          },
        };

        const order = getGatePlanGateIds(gateResult.plan);
        if (recordNonTestOnly && existingNonTestGate?.gate) {
          const existingResults = Array.isArray(existingNonTestGate.gate.results)
            ? existingNonTestGate.gate.results.filter((result) =>
                order.includes(result.id),
              )
            : [];
          const keepIds = new Set(existingResults.map((result) => result.id));
          const existingArtifacts = Array.isArray(existingNonTestGate.gate.artifacts)
            ? existingNonTestGate.gate.artifacts.filter((artifact) => {
                const value = String(artifact);
                for (const id of keepIds) {
                  if (value.includes(`${id}-`)) return true;
                }
                return false;
              })
            : [];
          const merged = mergeGateShardResults(
            [
              {
                ...existingNonTestGate.gate,
                results: existingResults,
                artifacts: existingArtifacts,
              },
              shardPayload.gate,
            ],
            order,
          );
          shardPayload = {
            schema_version: "gate-shard.v1",
            shard: shardPayloadShard,
            gate: merged,
          };
        }
        await writeJsonFile(shardPath, shardPayload);

        const shardFiles = await collectShardFiles(resolvedShardDir, shardSpec.count);
        const completed = shardFiles
          .filter((entry) => entry.index > 0)
          .map((entry) => entry.index);
        const nonTestPresent = shardFiles.some((entry) => entry.index === 0);
        const nonTestIds = order.filter((id) => {
          const lower = String(id).toLowerCase();
          return lower !== "test";
        });
        const nonTestSource = recordNonTestOnly ? shardPayload : existingNonTestGate;
        const fallbackNonTest: {
          nonTestCompleted?: string[];
          nonTestTotal?: number;
          nonTestComplete?: boolean;
        } = {
          nonTestCompleted: Array.isArray(progressCarry["non_test_completed"])
            ? (progressCarry["non_test_completed"] as string[])
            : [],
          nonTestTotal:
            typeof progressCarry["non_test_total"] === "number"
              ? (progressCarry["non_test_total"] as number)
              : nonTestIds.length,
        };
        if (typeof progressCarry["non_test_complete"] === "boolean") {
          fallbackNonTest.nonTestComplete = progressCarry[
            "non_test_complete"
          ] as boolean;
        }
        const {
          nonTestCompleted,
          nonTestTotal,
          nonTestComplete,
        } = resolveNonTestStatus({
          shard0: nonTestSource,
          nonTestIds,
          fallback: fallbackNonTest,
        });
        const progressPayload = {
          schema_version: "gate-progress.v1",
          ...(cycleId ? { cycle_id: cycleId } : {}),
          mode,
          shard: { count: shardSpec.count },
          completed,
          shard_outputs: shardFiles.map((entry) =>
            toSafeRelativePath(target.root, entry.path),
          ),
          gate_full_path: toSafeRelativePath(target.root, gateFullPath),
          non_test_path: toSafeRelativePath(target.root, localNonTestPath),
          non_test_present: nonTestPresent,
          non_test_total: nonTestTotal,
          non_test_completed: nonTestCompleted,
          non_test_complete: nonTestComplete,
          updated_at: new Date().toISOString(),
        };
        if (progressPath) {
          await writeJsonFile(progressPath, progressPayload);
        }

        if (completed.length === shardSpec.count && nonTestPresent && nonTestComplete) {
          const payloads: GateShardPayload[] = [];
          for (const entry of shardFiles) {
            const shardPayload = await readJson<GateShardPayload>(entry.path, null);
            if (shardPayload) payloads.push(shardPayload);
          }
          const assembled = assembleGateShardPayloads(payloads);
          await writeJsonFile(gateFullPath, assembled);
        }
      };
      const buildProgressPayloadFromDisk = async ({
        shardSpec,
        shardBudgetRemainingMs,
        testShardTimeoutMs,
        elapsedMs,
        resumeCommand: nextResumeCommand,
        testShardActive,
      }: {
        shardSpec: GateShardSpec;
        shardBudgetRemainingMs: number;
        testShardTimeoutMs?: number;
        elapsedMs: number;
        resumeCommand: string | null;
        testShardActive: number | null;
      }) => {
        const resolvedShardDir = shardDir
          ? shardDir
          : cycleId
            ? path.join(target.storePath, "cycles", cycleId)
            : path.join(target.storePath, "gates");
        const shardFiles = await collectShardFiles(resolvedShardDir, shardSpec.count);
        const completed = shardFiles
          .filter((entry) => entry.index > 0)
          .map((entry) => entry.index);
        const completedSet = new Set(completed);
        const pending: number[] = [];
        for (let index = 1; index <= shardSpec.count; index += 1) {
          if (!completedSet.has(index)) pending.push(index);
        }
        const gateFullPath = path.join(resolvedShardDir, "gate-full.json");
        const nonTestPath = path.join(
          resolvedShardDir,
          `gate-full.shard-0-of-${shardSpec.count}.json`,
        );
        const nonTestPresent = shardFiles.some((entry) => entry.index === 0);
        return {
          schema_version: "gate-progress.v1",
          ...(cycleId ? { cycle_id: cycleId } : {}),
          mode,
          shard: { count: shardSpec.count },
          ...progressCarry,
          completed,
          test_shard_active: testShardActive,
          test_shard_pending: pending,
          test_shard_completed: completed,
          shard_budget_ms: shardBudgetValue,
          shard_budget_remaining_ms: shardBudgetRemainingMs,
          ...(typeof testShardTimeoutMs === "number"
            ? { test_shard_timeout_ms: testShardTimeoutMs }
            : {}),
          elapsed_ms: elapsedMs,
          resume_command: nextResumeCommand,
          shard_outputs: shardFiles.map((entry) =>
            toSafeRelativePath(target.root, entry.path),
          ),
          gate_full_path: toSafeRelativePath(target.root, gateFullPath),
          non_test_path: toSafeRelativePath(target.root, nonTestPath),
          non_test_present: nonTestPresent,
          updated_at: new Date().toISOString(),
        };
      };
      await runPluginHooks({
        target,
        hook: "gate.pre",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.pre",
          action: "gate",
          mode,
          target: { id: target.id, root: target.root },
        },
      });
      let budgetExhausted = false;
      let resumeCommand: string | null = null;
      const batchExecuted: number[] = [];
      let batchPending: number[] = [];
      const skipNormalizeResults = false;
      const gate = shard
        ? await (async () => {
            const { gates, plan } = await buildGatePlan({
              root: target.root,
              config: target.config,
              mode,
            });
            const nonTestSource = plan.gates.length ? plan.gates : gates;
            const nonTestGates = nonTestSource.filter((entry) =>
              shouldRunGateForShard(entry, shard, { nonTestOnly: true }),
            );
            const nonTestIds = nonTestGates.map((entry) => entry.id);
            const pendingNonTest = nonTestIds.filter(
              (id) => !existingNonTestResults.has(id),
            );
            if (!nonTestOnly && shardBatchSize > 1) {
              const { pending, selected } = selectShardBatch({
                count: shard.count,
                completed: completedFromProgress,
                startIndex: shard.index,
                batchSize: shardBatchSize,
              });
              batchPending = pending;
              const selectedList = selected.length ? selected : [];
              if (!selectedList.length) {
                return {
                  ok: true,
                  results: [],
                  artifacts: [],
                  plan,
                  mode,
                  targetId: target.id,
                  queueId: null,
                  totalDurationMs: 0,
                  preflight: null,
                  overrides: null,
                };
              }
              const initialBudget = computeShardBudget({
                remainingMs: shardBudgetValue,
                safetyMs: SHARD_TIMEOUT_SAFETY_MS,
                minStartMs: SHARD_MIN_START_MS,
              });
              if (shardBudgetValue === 0 || !initialBudget.canStart) {
                budgetExhausted = true;
                resumeCommand = formatShardBatchResume(
                  shard,
                  shardBatchSize,
                  shardBudgetValue,
                );
                if (progressPath) {
                  const progressPayload = await buildProgressPayloadFromDisk({
                    shardSpec: shard,
                    shardBudgetRemainingMs: initialBudget.remainingMs,
                    testShardTimeoutMs: initialBudget.timeoutMs,
                    elapsedMs: 0,
                    resumeCommand,
                    testShardActive: null,
                  });
                  await writeJsonFile(progressPath, progressPayload);
                }
                return {
                  ok: true,
                  results: [],
                  artifacts: [],
                  plan,
                  mode,
                  targetId: target.id,
                  queueId: null,
                  totalDurationMs: 0,
                  preflight: null,
                  overrides: null,
                };
              }
              const batchStart = Date.now();
              const completedState = new Set(completedFromProgress);
              const aggregated: GateRunResult = {
                ok: true,
                results: [],
                artifacts: [],
                plan,
                mode,
                targetId: target.id,
                queueId: null,
                totalDurationMs: 0,
                preflight: null,
                overrides: null,
              };
              for (const index of selectedList) {
                const elapsedMs = Date.now() - batchStart;
                const remainingMs =
                  shardBudgetValue > 0 ? Math.max(0, shardBudgetValue - elapsedMs) : 0;
                const shardBudget = computeShardBudget({
                  remainingMs,
                  safetyMs: SHARD_TIMEOUT_SAFETY_MS,
                  minStartMs: SHARD_MIN_START_MS,
                });
                if (shardBudgetValue > 0 && !shardBudget.canStart) {
                  budgetExhausted = true;
                  resumeCommand = formatShardBatchResume(
                    shard,
                    shardBatchSize,
                    shardBudgetValue,
                  );
                  break;
                }
                if (progressPath) {
                  const completedList = Array.from(completedState).sort((a, b) => a - b);
                  const progressPayload = {
                    schema_version: "gate-progress.v1",
                    ...(cycleId ? { cycle_id: cycleId } : {}),
                    mode,
                    shard: { count: shard.count },
                    completed: completedList,
                    test_shard_active: index,
                    test_shard_pending: pending,
                    test_shard_completed: completedList,
                    shard_budget_ms: shardBudgetValue,
                    shard_budget_remaining_ms: shardBudget.remainingMs,
                    test_shard_timeout_ms: shardBudget.timeoutMs,
                    elapsed_ms: elapsedMs,
                    ...progressCarry,
                    updated_at: new Date().toISOString(),
                  };
                  await writeJsonFile(progressPath, progressPayload);
                }
                const currentShard = { index, count: shard.count };
                const gated = gates
                  .filter((entry) =>
                    shouldRunGateForShard(entry, currentShard, {
                      nonTestOnly: false,
                    }),
                  )
                  .map((entry) => {
                    const rewritten = rewriteGateForShard(entry, currentShard, {
                      nonTestOnly: false,
                      budgetMs: nonTestBudgetValue,
                    });
                    if (shardBudgetValue > 0 && shardBudget.timeoutMs > 0 && isTestGate(rewritten)) {
                      return { ...rewritten, timeoutMs: shardBudget.timeoutMs };
                    }
                    return rewritten;
                  });
                const shardPlan = {
                  ...plan,
                  gates: plan.gates.map((entry) =>
                    rewriteGateForShard(entry, currentShard, {
                      nonTestOnly: true,
                      budgetMs: nonTestBudgetValue,
                    }),
                  ),
                };
                const gateResult = await runGateSelection({
                  root: target.root,
                  targetId: target.id,
                  queueId: null,
                  mode,
                  plan: shardPlan,
                  gates: gated,
                  artifactsDir,
                  env,
                  ...(noBrowser ? { noBrowser } : {}),
                  ...(progress ? { progress } : {}),
                });
                const timedOut = gateResult.results.some(
                  (result) => result.exitCode === 124,
                );
                const normalizedResults = normalizeGateResults(
                  gateResult,
                  currentShard,
                );
                aggregated.ok = aggregated.ok && Boolean(gateResult.ok);
                aggregated.results.push(...gateResult.results);
                aggregated.artifacts.push(...(gateResult.artifacts ?? []));
                aggregated.totalDurationMs += Number(gateResult.totalDurationMs ?? 0) || 0;
                if (!aggregated.preflight) aggregated.preflight = gateResult.preflight ?? null;
                if (!aggregated.overrides) aggregated.overrides = gateResult.overrides ?? null;
                batchExecuted.push(index);
                if (timedOut) {
                  budgetExhausted = true;
                  resumeCommand = formatShardBatchResume(
                    shard,
                    shardBatchSize,
                    shardBudgetValue,
                  );
                  break;
                }
                await recordShardOutputs({
                  shardSpec: currentShard,
                  gateResult,
                  normalizedResults,
                  existingNonTestGate: existingNonTest,
                  nonTestOnly: false,
                });
                completedState.add(index);
              }
              if (budgetExhausted && progressPath) {
                const progressPayload = await buildProgressPayloadFromDisk({
                  shardSpec: shard,
                  shardBudgetRemainingMs:
                    shardBudgetValue > 0
                      ? Math.max(0, shardBudgetValue - (Date.now() - batchStart))
                      : 0,
                  elapsedMs: Date.now() - batchStart,
                  resumeCommand,
                  testShardActive: null,
                });
                await writeJsonFile(progressPath, progressPayload);
              }
              return aggregated;
            }
            const gated = (() => {
              if (!nonTestOnly) {
                return gates
                  .filter((entry) =>
                    shouldRunGateForShard(entry, shard, { nonTestOnly }),
                  )
                  .map((entry) =>
                    rewriteGateForShard(entry, shard, {
                      nonTestOnly,
                      budgetMs: nonTestBudgetValue,
                    }),
                  );
              }
              if (!pendingNonTest.length) return [];
              const nextGate = nonTestGates.find(
                (entry) => entry.id === pendingNonTest[0],
              );
              return nextGate
                ? [
                    rewriteGateForShard(nextGate, shard, {
                      nonTestOnly: true,
                      budgetMs: nonTestBudgetValue,
                    }),
                  ]
                : [];
            })();
            const shardPlan = {
              ...plan,
              gates: plan.gates.map((entry) =>
                rewriteGateForShard(entry, shard, {
                  nonTestOnly: true,
                  budgetMs: nonTestBudgetValue,
                }),
              ),
            };
            if (nonTestOnly && gated.length) {
              const resolvedShardDir = shardDir
                ? shardDir
                : cycleId
                  ? path.join(target.storePath, "cycles", cycleId)
                  : path.join(target.storePath, "gates");
              const progressPath = path.join(resolvedShardDir, "gate-progress.json");
              const gateFullPath = path.join(resolvedShardDir, "gate-full.json");
              const nonTestPath = path.join(
                resolvedShardDir,
                `gate-full.shard-0-of-${shard.count}.json`,
              );
              const progressPayload = {
                schema_version: "gate-progress.v1",
                ...(cycleId ? { cycle_id: cycleId } : {}),
                mode,
                shard: { count: shard.count },
                non_test_active_step: gated[0]?.id ?? null,
                non_test_pending: pendingNonTest,
                gate_full_path: toSafeRelativePath(target.root, gateFullPath),
                non_test_path: toSafeRelativePath(target.root, nonTestPath),
                updated_at: new Date().toISOString(),
                non_test_started_at: new Date().toISOString(),
              };
              await writeJsonFile(progressPath, progressPayload);
            }
            if (!gated.length && nonTestOnly) {
              const fallbackGate = existingNonTest?.gate ?? {
                ok: true,
                mode,
                results: [],
                total_duration_ms: 0,
                plan: shardPlan,
                preflight: null,
                overrides: null,
                artifacts: [],
              };
              return {
                ok: Boolean(fallbackGate.ok),
                results: [],
                artifacts: fallbackGate.artifacts ?? [],
                plan: shardPlan,
                mode,
                targetId: target.id,
                queueId: null,
                totalDurationMs: Number(fallbackGate.total_duration_ms ?? 0) || 0,
                preflight: null,
                overrides: null,
              };
            }
            return await runGateSelection({
              root: target.root,
              targetId: target.id,
              queueId: null,
              mode,
              plan: shardPlan,
              gates: gated,
              artifactsDir,
              env,
              ...(noBrowser ? { noBrowser } : {}),
              ...(progress ? { progress } : {}),
            });
          })()
        : await runGates({
            root: target.root,
            targetId: target.id,
            queueId: null,
            mode,
            config: target.config,
            artifactsDir,
            env,
            ...(noBrowser ? { noBrowser } : {}),
            ...(progress ? { progress } : {}),
          });
      const gateOk = budgetExhausted ? true : gate.ok;
      await runPluginHooks({
        target,
        hook: "gate.post",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.post",
          action: "gate",
          mode,
          target: { id: target.id, root: target.root },
          metadata: { ok: gateOk },
        },
      });

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "gate_run",
        target_id: target.id,
        mode: gate.mode,
        commands: gate.results.map((result) => ({
          cmd: result.command,
          cwd: target.root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })),
        artifacts: gate.artifacts,
        summary: `gate ${gateOk ? "ok" : "fail"}`,
      });

      const results = skipNormalizeResults
        ? gate.results
        : normalizeGateResults(gate, shard);
      const gatePayload = {
        ok: gateOk,
        mode,
        results,
        total_duration_ms: gate.totalDurationMs,
        plan: gate.plan,
        preflight: gate.preflight,
        overrides: gate.overrides,
        ...(shardBatchSize > 1
          ? {
              shard_batch: {
                requested: shardBatchSize,
                executed: batchExecuted,
                pending: batchPending,
                budget_ms: shardBudgetValue,
                budget_exhausted: budgetExhausted,
                resume_command: resumeCommand,
              },
            }
          : {}),
        recommendation: {
          mode: recommendation.mode,
          rationale: recommendation.rationale,
          risks: recommendation.risks,
          touched: recommendation.touched,
          changedFiles: recommendation.changedFiles,
          rules: recommendation.rules,
        },
        selected: {
          mode,
          overridden,
        },
      };

      if (json) {
        writeJson(gatePayload);
      } else {
        const lines = [
          formatTargetLine(target),
          `gate: ${gate.ok ? "ok" : "fail"} (${mode})`,
          `recommended: ${recommendation.mode}${
            overridden ? ` (selected ${mode})` : ""
          }`,
          recommendation.risks.length
            ? `risks: ${recommendation.risks.join(", ")}`
            : "risks: none",
        ];
        const warning = getPreflightWarning(gate.preflight);
        if (warning) {
          lines.push(`preflight: ${warning}`);
        }
        for (const result of gate.results) {
          const statusLabel =
            result.status === "skipped"
              ? "SKIP"
              : result.ok
                ? "PASS"
                : "FAIL";
          lines.push(
            `- ${result.id}: ${statusLabel} (${result.command})`,
          );
          if (result.status === "skipped" && result.skip_reason) {
            lines.push(`  reason: ${result.skip_reason}`);
          }
          if (result.artifact) lines.push(`  artifact: ${result.artifact}`);
          if (reportTouched) {
            const touched = result.touched_files ?? [];
            lines.push(
              `  touched: ${touched.length ? touched.join(", ") : "none"}`,
            );
          }
          if (!result.ok) {
            const triageSummary = getTriageSummary(result.triage);
            if (triageSummary) {
              lines.push(`  triage: ${triageSummary}`);
            } else {
              lines.push("  triage: none (see artifact for details)");
            }
          }
        }
        if (explain) {
          lines.push("");
          lines.push("touched surfaces:");
          lines.push(
            recommendation.touched.length
              ? recommendation.touched.map((entry) => `- ${entry}`).join("\n")
              : "- none",
          );
          if (recommendation.rules.length) {
            lines.push("");
            lines.push("risk rules:");
            for (const rule of recommendation.rules) {
              lines.push(`- ${rule.id}: ${rule.description}`);
              for (const match of rule.matches) {
                lines.push(`  - ${match}`);
              }
            }
          }
        }
        writeLines(lines);
      }

      if (!gateOk) {
        process.exitCode = 4;
      }

      if (shard && shardBatchSize <= 1) {
        const shardLabel = nonTestOnly
          ? `0-of-${shard.count}`
          : formatShardLabel(shard);
        const resolvedShardDir = shardDir
          ? shardDir
          : cycleId
            ? path.join(target.storePath, "cycles", cycleId)
            : path.join(target.storePath, "gates");
        const shardPath = path.join(
          resolvedShardDir,
          `gate-full.shard-${shardLabel}.json`,
        );
        const nonTestPath = path.join(
          resolvedShardDir,
          `gate-full.shard-0-of-${shard.count}.json`,
        );
        const progressPath = path.join(resolvedShardDir, "gate-progress.json");
        const gateFullPath = path.join(resolvedShardDir, "gate-full.json");
        const shardPayloadShard = nonTestOnly
          ? { index: 0, count: shard.count }
          : shard;
        let shardPayload: GateShardPayload = {
          schema_version: "gate-shard.v1",
          shard: shardPayloadShard,
          gate: {
            ok: gate.ok,
            mode,
            results,
            total_duration_ms: gate.totalDurationMs,
            plan: toJsonValue(gate.plan, target.root),
            preflight: toJsonValue(gate.preflight, target.root),
            overrides: toJsonValue(gate.overrides, target.root),
            artifacts: normalizeArtifacts(
              target.root,
              gate.artifacts ?? [],
            ),
          },
        };

        const order = getGatePlanGateIds(gate.plan);
        if (nonTestOnly && existingNonTest?.gate) {
          const existingResults = Array.isArray(existingNonTest.gate.results)
            ? existingNonTest.gate.results.filter((result) => order.includes(result.id))
            : [];
          const keepIds = new Set(existingResults.map((result) => result.id));
          const existingArtifacts = Array.isArray(existingNonTest.gate.artifacts)
            ? existingNonTest.gate.artifacts.filter((artifact) => {
                const value = String(artifact);
                for (const id of keepIds) {
                  if (value.includes(`${id}-`)) return true;
                }
                return false;
              })
            : [];
          const merged = mergeGateShardResults(
            [
              {
                ...existingNonTest.gate,
                results: existingResults,
                artifacts: existingArtifacts,
              },
              shardPayload.gate,
            ],
            order,
          );
          shardPayload = {
            schema_version: "gate-shard.v1",
            shard: shardPayloadShard,
            gate: merged,
          };
        }
        await writeJsonFile(shardPath, shardPayload);

        const shardFiles = await collectShardFiles(resolvedShardDir, shard.count);
        const completed = shardFiles
          .filter((entry) => entry.index > 0)
          .map((entry) => entry.index);
        const nonTestPresent = shardFiles.some((entry) => entry.index === 0);
        const nonTestIds = order.filter((id) => {
          const lower = String(id).toLowerCase();
          return lower !== "test";
        });
        const nonTestSource = nonTestOnly ? shardPayload : existingNonTest;
        const { nonTestCompleted, nonTestTotal, nonTestComplete } = deriveNonTestStatus({
          shard0: nonTestSource,
          nonTestIds,
        });
        const progressPayload = {
          schema_version: "gate-progress.v1",
          ...(cycleId ? { cycle_id: cycleId } : {}),
          mode,
          shard: { count: shard.count },
          completed,
          shard_outputs: shardFiles.map((entry) =>
            toSafeRelativePath(target.root, entry.path),
          ),
          gate_full_path: toSafeRelativePath(target.root, gateFullPath),
          non_test_path: toSafeRelativePath(target.root, nonTestPath),
          non_test_present: nonTestPresent,
          non_test_total: nonTestTotal,
          non_test_completed: nonTestCompleted,
          non_test_complete: nonTestComplete,
          updated_at: new Date().toISOString(),
        };
        await writeJsonFile(progressPath, progressPayload);

        if (completed.length === shard.count && nonTestPresent && nonTestComplete) {
          const payloads: GateShardPayload[] = [];
          for (const entry of shardFiles) {
            const shardPayload = await readJson<GateShardPayload>(entry.path, null);
            if (shardPayload) payloads.push(shardPayload);
          }
          const assembled = assembleGateShardPayloads(payloads);
          await writeJsonFile(gateFullPath, assembled);
        }
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "retry") {
    const stepRaw = flags["step"];
    if (typeof stepRaw !== "string" || !stepRaw.trim()) {
      throw new Error("Usage: ato gate retry --step <id> [--mode fast|full]");
    }
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

    try {
      const requestedMode =
        typeof flags["mode"] === "string" ? flags["mode"] : "full";
      const mode = requestedMode;
      if (!["fast", "full"].includes(mode)) {
        throw new Error(`Invalid --mode '${mode}'. Use 'fast' or 'full'.`);
      }
      const step = stepRaw.trim();
      const noBrowser = Boolean(flags["no-browser"]);
      const heartbeat = parseHeartbeat(flags["heartbeat"], {
        defaultEnabled: process.stdout.isTTY !== true,
      });
      const progress = !json ? createProgressReporter({ heartbeat }) : null;
      const artifactsDir = getArtifactsDir(target.storePath, null, "gate");
      const resolved = resolveGateConfig({ config: target.config, targetId: target.id });
      const gateConfig = {
        gates: resolved.effective,
        ...(typeof target.config.storeDir === "string"
          ? { storeDir: target.config.storeDir }
          : {}),
      };
      const { gates, plan } = await listGateCommands({
        config: gateConfig,
        mode,
        root: target.root,
      });
      const selected = gates.filter((gate) => gate.id === step);
      if (!selected.length) {
        throw new Error(`Unknown gate step '${step}'.`);
      }
      const selectedPlan = { ...plan, gates: selected };
      await runPluginHooks({
        target,
        hook: "gate.pre",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.pre",
          action: "gate",
          mode,
          target: { id: target.id, root: target.root },
        },
      });
      const gate = await runGateSelection({
        root: target.root,
        targetId: target.id,
        queueId: null,
        mode,
        plan: selectedPlan,
        gates: selected,
        artifactsDir,
        env: process.env,
        overrides: resolved.overrides,
        ...(noBrowser ? { noBrowser } : {}),
        ...(progress ? { progress } : {}),
      });
      await runPluginHooks({
        target,
        hook: "gate.post",
        enabled: context.pluginsEnabled,
        payload: {
          hook: "gate.post",
          action: "gate",
          mode,
          target: { id: target.id, root: target.root },
          metadata: { ok: gate.ok },
        },
      });

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "gate_run",
        target_id: target.id,
        mode: gate.mode,
        commands: gate.results.map((result) => ({
          cmd: result.command,
          cwd: target.root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })),
        artifacts: gate.artifacts,
        summary: `gate retry ${step} ${gate.ok ? "ok" : "fail"}`,
      });

      if (json) {
        const results = gate.results.map((result) => ({
          ...result,
          duration_ms: result.durationMs,
          started_at: result.started_at,
          ended_at: result.ended_at,
        }));
        writeJson({
          ok: gate.ok,
          mode,
          step,
          results,
          total_duration_ms: gate.totalDurationMs,
          plan: gate.plan,
          preflight: gate.preflight,
          overrides: gate.overrides,
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `gate retry: ${gate.ok ? "ok" : "fail"} (${mode})`,
          `step: ${step}`,
        ];
        const warning = getPreflightWarning(gate.preflight);
        if (warning) {
          lines.push(`preflight: ${warning}`);
        }
        for (const result of gate.results) {
          const statusLabel =
            result.status === "skipped"
              ? "SKIP"
              : result.ok
                ? "PASS"
                : "FAIL";
          lines.push(
            `- ${result.id}: ${statusLabel} (${result.command})`,
          );
          if (result.status === "skipped" && result.skip_reason) {
            lines.push(`  reason: ${result.skip_reason}`);
          }
          if (result.artifact) {
            lines.push(`  artifact: ${result.artifact}`);
          }
        }
        writeLines(lines);
      }

      if (!gate.ok) {
        process.exitCode = 4;
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown gate subcommand." },
    });
  } else {
    writeLines(["Unknown gate subcommand.", "Usage: ato gate run|retry|explain"]);
  }
  process.exitCode = 1;
};
