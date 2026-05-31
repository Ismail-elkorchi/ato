import path from "node:path";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { runGates } from "../../core/gates/runner.js";
import { resolveGateConfig } from "../../core/gates/overrides.js";
import { recommendGateMode } from "../../core/gates/recommend.js";
import { resolveGateEnv } from "../../core/gates/env.js";
import { runPluginHooks } from "../../core/plugins/runner.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import type { JsonValue } from "../../core/types.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato gate run|explain",
  "",
  "Options:",
  "  --mode <fast|full>       Select gate mode",
  "  --explain                Include recommendation details",
  "  --report-touched         Show files touched by each step",
  "  --no-browser             Skip browser-like gate steps",
  "  --heartbeat <seconds>    Print progress heartbeats while a step runs",
].join("\n");
const HELP_TOKENS = new Set(["help", "-h", "--help"]);
const RUN_FLAGS = new Set([
  "explain",
  "heartbeat",
  "help",
  "json",
  "mode",
  "no-browser",
  "report-touched",
]);
const EXPLAIN_FLAGS = new Set(["help", "json"]);

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const toSafeRelativePath = (root: string, filePath: string): string => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel === "." || rel.startsWith("..")) return "<redacted>";
  return toPosixPath(rel);
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

const createProgressReporter = ({
  heartbeat,
}: {
  heartbeat: { enabled: boolean; heartbeatMs: number; heartbeatTicks: number };
}) => ({
  onEvent: (event: { type: string; id: string; ok?: boolean }) => {
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

const assertKnownFlags = (
  flags: Record<string, string | boolean>,
  allowed: Set<string>,
): void => {
  const unknown = Object.keys(flags).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Unknown option: --${unknown}`);
  }
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

  if (subcommand === "explain") {
    assertKnownFlags(flags, EXPLAIN_FLAGS);
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
    assertKnownFlags(flags, RUN_FLAGS);
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

    try {
      const recommendation = await recommendGateMode({ root: target.root });
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
      const env = resolveGateEnv(target.root);

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

      const gate = await runGates({
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
        summary: `gate ${gate.ok ? "ok" : "fail"}`,
      });

      const results: GateRunResult["results"] = gate.results.map((result) => ({
        ...result,
        artifact: normalizeArtifactPath(target.root, result.artifact),
        triage: toJsonValue(result.triage, target.root) as GateRunResult["results"][number]["triage"],
      }));
      const gatePayload = {
        ok: gate.ok,
        mode,
        results,
        total_duration_ms: gate.totalDurationMs,
        plan: toJsonValue(gate.plan, target.root),
        preflight: toJsonValue(gate.preflight, target.root),
        overrides: toJsonValue(gate.overrides, target.root),
        artifacts: normalizeArtifacts(target.root, gate.artifacts ?? []),
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
    writeLines(["Unknown gate subcommand.", "Usage: ato gate run|explain"]);
  }
  process.exitCode = 1;
};
