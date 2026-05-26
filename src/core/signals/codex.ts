import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import { ensureDir, readJson, readJsonl, stableStringify } from "../fs.js";
import { isIsoDate } from "../queue/transitions.js";
import type {
  JsonValue,
  TelemetryCodexSessionSummary,
  TelemetrySignalMetrics,
  TelemetrySignalPoint,
  TelemetrySignalReport,
} from "../types.js";

const SIGNAL_POINT_SCHEMA_URL = new URL(
  "../schemas/signal-point.v1.json",
  import.meta.url,
);
const SIGNAL_REPORT_SCHEMA_URL = new URL(
  "../schemas/signal-report.v1.json",
  import.meta.url,
);
const SESSION_SCHEMA_URL = new URL(
  "../schemas/agent-session.v1.json",
  import.meta.url,
);

type TelemetryIndexEntry = {
  session_id: string;
  summary_path: string;
  summary_hash: string;
  source_file_hash: string;
};

const formatJson = (value: JsonValue): string => {
  const normalizeValue = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) {
      return input.map((entry) => normalizeValue(entry));
    }
    if (input && typeof input === "object") {
      const entries = Object.entries(input).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      return entries.reduce<Record<string, JsonValue>>((acc, [key, val]) => {
        acc[key] = normalizeValue(val);
        return acc;
      }, {});
    }
    return input;
  };
  return `${JSON.stringify(normalizeValue(value), null, 2)}\n`;
};

const hashContent = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const asNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const normalizeMetric = (value: number | null): number => {
  if (value === null) return 0;
  return value < 0 ? 0 : Math.round(value);
};

const readTokenMetric = (
  summary: TelemetryCodexSessionSummary,
  key: string,
): number => {
  const raw = summary.token_summary?.[key];
  return normalizeMetric(asNumber(raw));
};

const buildCanonicalMetrics = (
  summary: TelemetryCodexSessionSummary,
): TelemetrySignalMetrics => {
  const inputTokens = readTokenMetric(summary, "input_tokens");
  const cachedInputTokens = readTokenMetric(summary, "cached_input_tokens");
  const outputTokens = readTokenMetric(summary, "output_tokens");
  const totalTokens =
    readTokenMetric(summary, "total_tokens") || inputTokens + outputTokens;
  const contextWindow = readTokenMetric(summary, "context_window");
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    context_window: contextWindow,
    tool_calls_count: normalizeMetric(summary.counts.tool_calls),
    error_count: normalizeMetric(summary.counts.errors),
  };
};

const loadSchema = async (url: URL): Promise<unknown> => {
  const raw = await fs.readFile(url, "utf8");
  return JSON.parse(raw);
};

const buildValidator = async (url: URL) => {
  const schema = await loadSchema(url);
  const ajv = createAjv();
  ajv.addFormat("date-time", isIsoDate);
  return ajv.compile(schema);
};

const readIndexEntries = async (indexPath: string): Promise<TelemetryIndexEntry[]> => {
  const records = await readJsonl<TelemetryIndexEntry>(indexPath);
  return records.map((record) => record.item);
};

const parseTimestamp = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const selectPeriod = (points: TelemetrySignalPoint[]): { from: string | null; to: string | null } => {
  const timestamps = points
    .map((point) => point.ts ?? null)
    .filter((value): value is string => Boolean(value));
  if (!timestamps.length) return { from: null, to: null };
  const ordered = timestamps
    .map((value) => ({ raw: value, numeric: parseTimestamp(value) }))
    .sort((a, b) => {
      if (a.numeric !== null && b.numeric !== null) {
        return a.numeric - b.numeric;
      }
      return a.raw.localeCompare(b.raw);
    });
  return {
    from: ordered[0]?.raw ?? null,
    to: ordered[ordered.length - 1]?.raw ?? null,
  };
};

const shouldInclude = ({
  summary,
  since,
  gitCommit,
}: {
  summary: TelemetryCodexSessionSummary;
  since: number | null;
  gitCommit: string | null;
}): boolean => {
  if (gitCommit) {
    return summary.git_commit_hash === gitCommit;
  }
  if (since !== null) {
    const stamp = parseTimestamp(summary.started_at ?? summary.ended_at ?? null);
    if (stamp === null) return false;
    return stamp >= since;
  }
  return true;
};

const buildPoint = (summary: TelemetryCodexSessionSummary): TelemetrySignalPoint => ({
  source: "codex",
  ts: summary.ended_at ?? summary.started_at ?? null,
  scope: {
    ...(summary.git_commit_hash ? { commit: summary.git_commit_hash } : {}),
  },
  metrics: buildCanonicalMetrics(summary),
});

const writeFileIfChanged = async (
  filePath: string,
  content: string,
): Promise<boolean> => {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return true;
};

const formatJsonl = (lines: string[]): string =>
  lines.length ? `${lines.join("\n")}\n` : "";

export const buildCodexSignalReport = async ({
  root,
  store,
  since,
  gitCommit,
  cycleId,
  writeReports = true,
}: {
  root: string;
  store: string;
  since: string | null;
  gitCommit: string | null;
  cycleId?: string | null;
  writeReports?: boolean;
}): Promise<{
  report: TelemetrySignalReport;
  indexPath: string;
  reportPath: string;
  reportHash: string;
  latestPath: string;
  latestHash: string;
  indexWritten: boolean;
  reportWritten: boolean;
  latestWritten: boolean;
  sessionsTotal: number;
  telemetryMissing: boolean;
  telemetryMissingReason: string | null;
}> => {
  const sessionValidator = await buildValidator(SESSION_SCHEMA_URL);
  const pointValidator = await buildValidator(SIGNAL_POINT_SCHEMA_URL);
  const reportValidator = await buildValidator(SIGNAL_REPORT_SCHEMA_URL);

  const telemetryDir = path.join(store, "telemetry", "codex");
  const indexPath = path.join(telemetryDir, "index.jsonl");
  let indexMissing = false;
  let entries: TelemetryIndexEntry[] = [];
  try {
    await fs.access(indexPath);
    entries = await readIndexEntries(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      indexMissing = true;
      entries = [];
    } else {
      throw error;
    }
  }

  const sinceValue = since ? Date.parse(since) : null;
  if (since && !Number.isFinite(sinceValue)) {
    throw new Error("--since must be a valid ISO timestamp.");
  }

  const points: TelemetrySignalPoint[] = [];
  const codexTotals = {
    shell_commands_total: 0,
    messages_user: 0,
    messages_assistant: 0,
  };
  const ordered = entries
    .slice()
    .sort((a, b) => a.summary_path.localeCompare(b.summary_path));

  for (const entry of ordered) {
    const summaryPath = path.resolve(root, entry.summary_path);
    const summary = await readJson<TelemetryCodexSessionSummary>(
      summaryPath,
      null,
    );
    if (!summary) {
      continue;
    }

    const validSummary = sessionValidator(summary);
    if (!validSummary) {
      const errors = (sessionValidator.errors ?? []).map(
        (err) => `${err.instancePath} ${err.message}`,
      );
      throw new Error(
        `Invalid telemetry summary at ${entry.summary_path}: ${errors.join("; ")}`,
      );
    }

    if (!shouldInclude({ summary, since: sinceValue, gitCommit })) {
      continue;
    }

    const point = buildPoint(summary);
    const validPoint = pointValidator(point);
    if (!validPoint) {
      const errors = (pointValidator.errors ?? []).map(
        (err) => `${err.instancePath} ${err.message}`,
      );
      throw new Error(
        `Invalid signal point for ${entry.summary_path}: ${errors.join("; ")}`,
      );
    }
    points.push(point);
    codexTotals.shell_commands_total += summary.counts.shell_commands;
    codexTotals.messages_user += summary.counts.messages_user;
    codexTotals.messages_assistant += summary.counts.messages_assistant;
  }

  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    total_tokens: 0,
    context_window: 0,
    tool_calls_count: 0,
    error_count: 0,
  };
  let contextWindowSum = 0;
  let contextWindowMax = 0;
  for (const point of points) {
    totals.input_tokens += point.metrics.input_tokens;
    totals.output_tokens += point.metrics.output_tokens;
    totals.cached_input_tokens += point.metrics.cached_input_tokens;
    totals.total_tokens += point.metrics.total_tokens;
    totals.tool_calls_count += point.metrics.tool_calls_count;
    totals.error_count += point.metrics.error_count;
    contextWindowSum += point.metrics.context_window;
    contextWindowMax = Math.max(contextWindowMax, point.metrics.context_window);
  }
  totals.context_window = contextWindowMax;

  const count = points.length;
  const averages = {
    input_tokens: count ? totals.input_tokens / count : 0,
    output_tokens: count ? totals.output_tokens / count : 0,
    cached_input_tokens: count ? totals.cached_input_tokens / count : 0,
    total_tokens: count ? totals.total_tokens / count : 0,
    context_window: count ? contextWindowSum / count : 0,
    tool_calls_count: count ? totals.tool_calls_count / count : 0,
    error_count: count ? totals.error_count / count : 0,
  };
  const codexAverages = {
    shell_commands_total: count ? codexTotals.shell_commands_total / count : 0,
    messages_user: count ? codexTotals.messages_user / count : 0,
    messages_assistant: count ? codexTotals.messages_assistant / count : 0,
  };

  const period = selectPeriod(points);
  const telemetryMissingReason = indexMissing ? "index_missing" : count === 0 ? "no_sessions" : null;
  const telemetryMissing = telemetryMissingReason !== null;
  const report: TelemetrySignalReport = {
    source: "codex",
    period,
    counts: { sessions_total: count },
    totals,
    averages,
    extensions: {
      codex: {
        telemetry_missing: telemetryMissing,
        telemetry_missing_reason: telemetryMissingReason,
        totals: codexTotals,
        averages: codexAverages,
      },
    },
  };

  const validReport = reportValidator(report);
  if (!validReport) {
    const errors = (reportValidator.errors ?? []).map(
      (err) => `${err.instancePath} ${err.message}`,
    );
    throw new Error(`Invalid signal report: ${errors.join("; ")}`);
  }

  const signalsDir = path.join(store, "signals", "codex");
  const latestPath = path.join(signalsDir, "latest.report.json");
  const reportContent = formatJson(report as JsonValue);
  const latestWritten = writeReports
    ? await writeFileIfChanged(latestPath, reportContent)
    : false;
  const latestHash = hashContent(reportContent);
  const reportPath = cycleId
    ? path.join(signalsDir, "reports", `${cycleId}.report.json`)
    : latestPath;
  const reportWritten = writeReports
    ? reportPath === latestPath
      ? latestWritten
      : await writeFileIfChanged(reportPath, reportContent)
    : false;
  const reportHash = latestHash;

  const signalsIndexPath = path.join(signalsDir, "index.jsonl");
  let indexWritten = false;
  if (writeReports) {
    let indexEntries: Array<Record<string, JsonValue>> = [];
    try {
      const raw = await fs.readFile(signalsIndexPath, "utf8");
      indexEntries = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, JsonValue>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const reportEntry = {
      source: "codex",
      path: path.relative(root, reportPath).split(path.sep).join("/"),
      sha256: reportHash,
      period,
      ...(cycleId ? { cycle_id: cycleId } : {}),
    };

    const last = indexEntries[indexEntries.length - 1];
    if (!last || String(last["sha256"] ?? "") !== reportHash) {
      indexEntries.push(reportEntry);
    }

    const indexContent = formatJsonl(
      indexEntries.map((entry) => stableStringify(entry)),
    );
    indexWritten = await writeFileIfChanged(signalsIndexPath, indexContent);
  }

  return {
    report,
    indexPath: signalsIndexPath,
    reportPath,
    reportHash,
    latestPath,
    latestHash,
    indexWritten,
    reportWritten,
    latestWritten,
    sessionsTotal: count,
    telemetryMissing,
    telemetryMissingReason,
  };
};
