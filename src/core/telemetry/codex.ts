import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import { ensureDir, listDirRecursive, stableStringify } from "../fs.js";
import { isIsoDate } from "../queue/transitions.js";
import type {
  JsonValue,
  TelemetryCodexIngestResult,
  TelemetryCodexSessionSummary,
} from "../types.js";

const REDACTION_PROFILE_ID = "codex-session-redaction.v1";
const SESSION_SCHEMA_URL = new URL(
  "../schemas/agent-session.v1.json",
  import.meta.url,
);
const INGEST_SCHEMA_URL = new URL(
  "../schemas/telemetry-ingest-result.v1.json",
  import.meta.url,
);
const MAX_COMMAND_SUMMARY = 200;

const toPosix = (value: string): string =>
  value.split(path.sep).join("/");

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const hashContent = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const normalizeEventType = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s.:-]+/g, "_");

const resolveInputFiles = async (inputPath: string): Promise<string[]> => {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) return [resolved];
  if (!stat.isDirectory()) {
    throw new Error("--path must be a file or directory.");
  }
  const entries = await listDirRecursive(resolved);
  const files = entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(resolved, entry));
  files.sort((a, b) =>
    toPosix(path.relative(resolved, a)).localeCompare(
      toPosix(path.relative(resolved, b)),
    ),
  );
  return files;
};

const selectTimestamp = (
  timestamps: string[],
): { startedAt: string | null; endedAt: string | null } => {
  if (!timestamps.length) return { startedAt: null, endedAt: null };
  const parsed = timestamps
    .map((value) => ({
      raw: value,
      numeric: Number.isFinite(Date.parse(value)) ? Date.parse(value) : null,
    }))
    .filter((entry) => entry.raw.length > 0);
  if (!parsed.length) return { startedAt: null, endedAt: null };
  const sorted = parsed.slice().sort((a, b) => {
    if (a.numeric !== null && b.numeric !== null) {
      return a.numeric - b.numeric;
    }
    return a.raw.localeCompare(b.raw);
  });
  return {
    startedAt: sorted[0]?.raw ?? null,
    endedAt: sorted[sorted.length - 1]?.raw ?? null,
  };
};

const sanitizeSessionId = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]+/g, "_");

const hashCwd = (cwd: string): string => hashContent(cwd);

const resolveCwd = (
  cwd: string,
  root: string,
): { cwd_rel?: string; cwd_hash?: string; cwd_hint?: string | null } => {
  if (!cwd) return {};
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(root, resolvedCwd);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const relPosix = toPosix(relative);
    return { cwd_rel: relPosix, cwd_hint: relPosix };
  }
  return { cwd_hash: hashCwd(cwd), cwd_hint: null };
};

const buildCommandHash = (value: string): string => hashContent(value);

const extractCommandString = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(" ").trim();
  }
  if (typeof value === "string") return value.trim();
  return "";
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

const formatJson = (value: unknown): string => {
  const normalizeValue = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => normalizeValue(entry));
    }
    if (input && typeof input === "object") {
      const entries = Object.entries(input as Record<string, unknown>).sort(
        ([a], [b]) => a.localeCompare(b),
      );
      return entries.reduce<Record<string, unknown>>((acc, [key, val]) => {
        acc[key] = normalizeValue(val);
        return acc;
      }, {});
    }
    return input;
  };
  return `${JSON.stringify(normalizeValue(value), null, 2)}\n`;
};

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

type TokenUsageCandidate = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  context_window: number;
};

type CommandSummaryEntry = TelemetryCodexSessionSummary["command_summary"][number];

const buildTokenSummary = (
  candidates: TokenUsageCandidate[],
): { summary: Record<string, number | string> } => {
  if (!candidates.length) {
    return { summary: { measurement_method: "missing" } };
  }
  let best: TokenUsageCandidate = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.total_tokens > best.total_tokens) {
      best = candidate;
      continue;
    }
    if (candidate.total_tokens === best.total_tokens) {
      if (candidate.input_tokens > best.input_tokens) {
        best = candidate;
      }
    }
  }
  return {
    summary: {
      ...best,
      measurement_method: "max_total",
    },
  };
};

const hasCreditBalance = (value: Record<string, unknown> | null): boolean => {
  if (!value) return false;
  const balance = value["balance"];
  return (
    typeof balance === "number" ||
    (typeof balance === "string" && balance.trim().length > 0)
  );
};

export const ingestCodexSessions = async ({
  root,
  store,
  inputPath,
}: {
  root: string;
  store: string;
  inputPath: string;
}): Promise<TelemetryCodexIngestResult> => {
  const files = await resolveInputFiles(inputPath);
  const sessionValidator = await buildValidator(SESSION_SCHEMA_URL);
  const resultValidator = await buildValidator(INGEST_SCHEMA_URL);

  const summaries: Array<{
    session_id: string;
    summary_path: string;
    summary_hash: string;
    source_file_hash: string;
  }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const telemetryDir = path.join(store, "telemetry", "codex");
  const sessionsDir = path.join(telemetryDir, "sessions");
  const indexPath = path.join(telemetryDir, "index.jsonl");

  const usedNames = new Set<string>();

  let summaryWrites = 0;
  for (const filePath of files) {
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      skipped.push({ path: filePath, reason: (error as Error).message });
      continue;
    }

    const sourceFileHash = hashContent(raw);
    const warnings = new Set<string>();
    const tokens: TokenUsageCandidate[] = [];
    const counts = {
      messages_user: 0,
      messages_assistant: 0,
      tool_calls: 0,
      shell_commands: 0,
      errors: 0,
    };

    const commandSummary: CommandSummaryEntry[] = [];

    let sessionId = "";
    let originator: string | null = null;
    let modelProvider: string | null = null;
    let model: string | null = null;
    let cliVersion: string | null = null;
    let gitCommitHash: string | null = null;
    let gitBranch: string | null = null;
    let cwdValue: string | null = null;
    let instructionsHash: string | null = null;
    let rateLimitInfoPresent = false;
    let hasCredits = false;
    let sandboxMode: string | null = null;
    let approvalPolicy: string | null = null;
    let primaryUsedPercent: number | null = null;
    let secondaryUsedPercent: number | null = null;

    const timestamps: string[] = [];

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let entry: Record<string, unknown> | null = null;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        warnings.add("unparseable_line");
        continue;
      }
      if (!entry) continue;

      const typeRaw =
        asString(entry["type"]) ||
        asString(entry["event"]) ||
        asString(entry["kind"]) ||
        "";
      const type = normalizeEventType(typeRaw);

      const timestamp =
        asString(entry["ts"]) ||
        asString(entry["timestamp"]) ||
        asString(entry["created_at"]);
      if (timestamp) timestamps.push(timestamp);

      const sessionIdValue =
        asString(entry["session_id"]) ||
        asString(entry["sessionId"]);
      if (!sessionId && sessionIdValue) sessionId = sessionIdValue;

      if (type === "session_meta") {
        const payload = asRecord(entry["payload"]) ?? asRecord(entry["meta"]);
        if (payload) {
          const payloadOriginator = asString(payload["originator"]);
          if (!originator && payloadOriginator) originator = payloadOriginator;
          const payloadModelProvider =
            asString(payload["model_provider"]) ||
            asString(payload["modelProvider"]);
          if (!modelProvider && payloadModelProvider) {
            modelProvider = payloadModelProvider;
          }
          const payloadModel = asString(payload["model"]);
          if (!model && payloadModel) model = payloadModel;
          const payloadCli =
            asString(payload["cli_version"]) ||
            asString(payload["cliVersion"]);
          if (!cliVersion && payloadCli) cliVersion = payloadCli;
          const payloadCommit =
            asString(payload["git_commit_hash"]) ||
            asString(payload["gitCommitHash"]);
          if (!gitCommitHash && payloadCommit) gitCommitHash = payloadCommit;
          const payloadBranch =
            asString(payload["git_branch"]) ||
            asString(payload["gitBranch"]);
          if (!gitBranch && payloadBranch) gitBranch = payloadBranch;
          const payloadCwd = asString(payload["cwd"]);
          if (!cwdValue && payloadCwd) cwdValue = payloadCwd;
          const payloadSandbox = asString(payload["sandbox_mode"]);
          if (!sandboxMode && payloadSandbox) sandboxMode = payloadSandbox;
          const payloadApproval = asString(payload["approval_policy"]);
          if (!approvalPolicy && payloadApproval) approvalPolicy = payloadApproval;

          const instructions = asString(payload["instructions"]);
          if (instructions) {
            instructionsHash = hashContent(instructions);
            warnings.add("instructions_present_in_raw");
          }

          const payloadRateLimit =
            asRecord(payload["rate_limit"]) ?? asRecord(payload["rateLimit"]);
          if (payloadRateLimit) {
            rateLimitInfoPresent = true;
            const primary = asNumber(payloadRateLimit["primary_used_percent"]);
            if (primary !== null) primaryUsedPercent = primary;
            const secondary = asNumber(payloadRateLimit["secondary_used_percent"]);
            if (secondary !== null) secondaryUsedPercent = secondary;
          }

          const payloadCredits = asRecord(payload["credits"]);
          if (payloadCredits) {
            rateLimitInfoPresent = true;
            hasCredits = true;
            if (hasCreditBalance(payloadCredits)) {
              warnings.add("credit_fields_present_in_raw");
            }
          }

          const payloadSessionId =
            asString(payload["session_id"]) || asString(payload["sessionId"]);
          if (!sessionId && payloadSessionId) sessionId = payloadSessionId;

          const payloadStarted =
            asString(payload["started_at"]) || asString(payload["startedAt"]);
          if (payloadStarted) timestamps.push(payloadStarted);
          const payloadEnded =
            asString(payload["ended_at"]) || asString(payload["endedAt"]);
          if (payloadEnded) timestamps.push(payloadEnded);

          const gitMeta = asRecord(payload["git"]);
          if (gitMeta) {
            const gitCommit =
              asString(gitMeta["commit"]) ||
              asString(gitMeta["commit_hash"]) ||
              asString(gitMeta["commitHash"]);
            if (!gitCommitHash && gitCommit) gitCommitHash = gitCommit;
            const gitMetaBranch = asString(gitMeta["branch"]);
            if (!gitBranch && gitMetaBranch) gitBranch = gitMetaBranch;
          }
        }
      }

      if (type === "token_count") {
        const totalUsage =
          asRecord(entry["total_token_usage"]) ??
          asRecord(entry["totalTokenUsage"]) ??
          asRecord(entry["token_usage"]);
        if (totalUsage) {
          const totalTokens = asNumber(
            totalUsage["total_tokens"] ?? totalUsage["totalTokens"],
          );
          if (totalTokens !== null) {
            tokens.push({
              input_tokens:
                asNumber(totalUsage["input_tokens"] ?? totalUsage["inputTokens"]) ??
                0,
              cached_input_tokens:
                asNumber(
                  totalUsage["cached_input_tokens"] ??
                    totalUsage["cachedInputTokens"],
                ) ?? 0,
              output_tokens:
                asNumber(totalUsage["output_tokens"] ?? totalUsage["outputTokens"]) ??
                0,
              reasoning_output_tokens:
                asNumber(
                  totalUsage["reasoning_output_tokens"] ??
                    totalUsage["reasoningOutputTokens"],
                ) ?? 0,
              total_tokens: totalTokens,
              context_window:
                asNumber(totalUsage["context_window"] ?? totalUsage["contextWindow"]) ??
                0,
            });
          }
        }
      }

      if (type === "function_call" || type === "tool_call") {
        counts.tool_calls += 1;
        if (commandSummary.length < MAX_COMMAND_SUMMARY) {
          const name =
            asString(entry["name"]) || asString(entry["tool"]) || "function_call";
          const args = entry["arguments"] ?? entry["args"] ?? null;
          const commandString = args
            ? `${name}:${stableStringify(args as JsonValue)}`
            : name;
          commandSummary.push({
            kind: "tool_call",
            command_hash: buildCommandHash(commandString),
          });
        } else {
          warnings.add("command_summary_truncated");
        }
      }

      if (type === "shell_command") {
        counts.shell_commands += 1;
        const commandString =
          extractCommandString(entry["command"]) ||
          extractCommandString(entry["cmd"]);
        if (commandSummary.length < MAX_COMMAND_SUMMARY) {
          const exitCode = asNumber(entry["exit_code"] ?? entry["exitCode"]);
          const output = asString(entry["stdout"]) || asString(entry["stderr"]);
          commandSummary.push({
            kind: "shell_command",
            command_hash: buildCommandHash(commandString || "shell_command"),
            ...(exitCode !== null ? { exit_code: exitCode } : {}),
            ...(output ? { output_bytes: Buffer.byteLength(output) } : {}),
          });
        } else {
          warnings.add("command_summary_truncated");
        }
        const exitCode = asNumber(entry["exit_code"] ?? entry["exitCode"]);
        if (exitCode !== null && exitCode !== 0) {
          counts.errors += 1;
        }
      }

      if (type === "response_item") {
        const role =
          asString(entry["role"]) ||
          asString(asRecord(entry["item"])?.["role"]) ||
          asString(asRecord(entry["message"])?.["role"]);
        if (role === "user") counts.messages_user += 1;
        if (role === "assistant") counts.messages_assistant += 1;
      }

      const explicitError = entry["error"];
      const status = asString(entry["status"]);
      const okValue = entry["ok"];
      if (
        type === "error" ||
        Boolean(explicitError) ||
        status === "error" ||
        status === "failed" ||
        okValue === false
      ) {
        counts.errors += 1;
      }

      const entryRateLimit =
        asRecord(entry["rate_limit"]) ?? asRecord(entry["rateLimit"]);
      if (entryRateLimit) {
        rateLimitInfoPresent = true;
        const primary = asNumber(entryRateLimit["primary_used_percent"]);
        if (primary !== null) primaryUsedPercent = primary;
        const secondary = asNumber(entryRateLimit["secondary_used_percent"]);
        if (secondary !== null) secondaryUsedPercent = secondary;
      }
      const entryCredits = asRecord(entry["credits"]);
      if (entryCredits) {
        rateLimitInfoPresent = true;
        hasCredits = true;
        if (hasCreditBalance(entryCredits)) {
          warnings.add("credit_fields_present_in_raw");
        }
      }
    }

    if (!sessionId) {
      sessionId = path.basename(filePath, ".jsonl");
      warnings.add("session_id_missing");
    }

    const { startedAt, endedAt } = selectTimestamp(timestamps);
    const { summary } = buildTokenSummary(tokens);
    if (summary["measurement_method"] === "missing") {
      warnings.add("token_info_missing");
    }

    const warningList = [...warnings].sort((a, b) => a.localeCompare(b));

    const cwdResolved = resolveCwd(cwdValue ?? "", root);

    const summaryRecord: TelemetryCodexSessionSummary = {
      schema_version: "agent-session.v1",
      source: "codex",
      session_id: sessionId,
      originator,
      model_provider: modelProvider,
      model,
      cli_version: cliVersion,
      git_commit_hash: gitCommitHash,
      git_branch: gitBranch,
      started_at: startedAt,
      ended_at: endedAt,
      counts,
      rate_limit_info_present: rateLimitInfoPresent,
      ...(instructionsHash ? { instructions_hash: instructionsHash } : {}),
      ...(cwdResolved.cwd_rel ? { cwd_rel: cwdResolved.cwd_rel } : {}),
      ...(cwdResolved.cwd_hash ? { cwd_hash: cwdResolved.cwd_hash } : {}),
      repo: {
        git_commit_hash: gitCommitHash,
        branch: gitBranch,
        cwd_hint: cwdResolved.cwd_hint ?? null,
      },
      runtime: {
        model,
        cli_version: cliVersion,
        originator,
        sandbox_mode: sandboxMode,
        approval_policy: approvalPolicy,
      },
      token_summary: summary as Record<string, number | string>,
      ...(rateLimitInfoPresent
        ? {
            rate_limit_summary: {
              ...(primaryUsedPercent !== null
                ? { primary_used_percent: primaryUsedPercent }
                : {}),
              ...(secondaryUsedPercent !== null
                ? { secondary_used_percent: secondaryUsedPercent }
                : {}),
              has_credits: hasCredits,
            },
          }
        : {}),
      command_summary: commandSummary,
      integrity: {
        source_file_hash: sourceFileHash,
        redaction_profile_id: REDACTION_PROFILE_ID,
        warnings: warningList,
      },
    };

    const ok = sessionValidator(summaryRecord);
    if (!ok) {
      const errors = (sessionValidator.errors ?? []).map(
        (error) => `${error.instancePath} ${error.message}`,
      );
      throw new Error(
        `Invalid telemetry session summary for ${filePath}: ${errors.join("; ")}`,
      );
    }

    const safeSessionId = sanitizeSessionId(sessionId);
    let summaryFileName = `${safeSessionId}.summary.json`;
    if (usedNames.has(summaryFileName)) {
      summaryFileName = `${safeSessionId}-${hashContent(filePath).slice(0, 8)}.summary.json`;
    }
    usedNames.add(summaryFileName);

    const summaryPath = path.join(sessionsDir, summaryFileName);
    const summaryContent = formatJson(summaryRecord);
    if (await writeFileIfChanged(summaryPath, summaryContent)) {
      summaryWrites += 1;
    }

    const summaryHash = hashContent(summaryContent);
    summaries.push({
      session_id: sessionId,
      summary_path: toPosix(path.relative(root, summaryPath)),
      summary_hash: summaryHash,
      source_file_hash: sourceFileHash,
    });
  }

  const indexLines = summaries.map((entry) => stableStringify(entry));
  const indexContent = formatJsonl(indexLines);
  const indexWritten = await writeFileIfChanged(indexPath, indexContent);
  const indexHash = hashContent(indexContent);

  const result: TelemetryCodexIngestResult = {
    ok: true,
    schema_version: "telemetry-ingest.v1",
    source: "codex",
    path: inputPath,
    counts: {
      files_scanned: files.length,
      sessions_ingested: summaries.length,
      sessions_skipped: skipped.length,
      summaries_written: summaryWrites,
      index_written: indexWritten,
    },
    outputs: {
      index: {
        path: toPosix(path.relative(root, indexPath)),
        sha256: indexHash,
      },
      summaries: summaries.map((entry) => ({
        session_id: entry.session_id,
        path: entry.summary_path,
        sha256: entry.summary_hash,
      })),
    },
    ...(skipped.length ? { skipped } : {}),
  };

  const resultOk = resultValidator(result);
  if (!resultOk) {
    const errors = (resultValidator.errors ?? []).map(
      (error) => `${error.instancePath} ${error.message}`,
    );
    throw new Error(`Invalid telemetry ingest result: ${errors.join("; ")}`);
  }

  return result;
};
