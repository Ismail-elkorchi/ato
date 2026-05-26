import os from "node:os";
import path from "node:path";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { ingestCodexSessions } from "../../core/telemetry/codex.js";
import { buildCodexSignalReport } from "../../core/signals/codex.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato telemetry codex ingest --path <file|dir>",
  "  ato telemetry codex report [--since <iso> | --git-commit <hash>] [--cycle-id <id>]",
  "",
  "Options:",
  "  --path <file|dir>  Codex sessions JSONL file or directory",
  "  --since <iso>      Filter sessions started on/after timestamp",
  "  --git-commit <hash>  Filter sessions by git commit hash",
  "  --cycle-id <id>    Optional cycle id for report artifact naming",
  "  --help             Show help",
].join("\n");

const expandHome = (value: string): string => {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const toRelativePath = (root: string, filePath: string): string => {
  const relative = path.relative(root, filePath);
  return relative.split(path.sep).join("/") || ".";
};

const normalizeOutputPath = (root: string, value: string): string =>
  path.isAbsolute(value) ? toRelativePath(root, value) : value;

export const runTelemetryCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags, positionals } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand !== "codex") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown telemetry source." } });
    } else {
      writeLines(["Unknown telemetry source.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const action = positionals[0];
  if (action !== "ingest" && action !== "report") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown telemetry action." } });
    } else {
      writeLines(["Unknown telemetry action.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
  try {
    if (action === "ingest") {
      const inputPathRaw =
        typeof flags["path"] === "string" ? flags["path"] : "~/.codex/sessions";
      const inputPath = expandHome(inputPathRaw);
      const result = await ingestCodexSessions({
        root: target.root,
        store: target.storePath,
        inputPath,
      });
      if (json) {
        writeJson(result);
      } else {
        writeLines([
          formatTargetLine(target),
          `telemetry ingest: ${result.source}`,
          `files scanned: ${result.counts.files_scanned}`,
          `sessions ingested: ${result.counts.sessions_ingested}`,
          `sessions skipped: ${result.counts.sessions_skipped}`,
          `summaries written: ${result.counts.summaries_written}`,
          `index: ${result.outputs.index.path}`,
        ]);
      }
      return;
    }

    const since = typeof flags["since"] === "string" ? flags["since"] : null;
    const gitCommit =
      typeof flags["git-commit"] === "string"
        ? flags["git-commit"]
        : typeof flags["gitCommit"] === "string"
          ? flags["gitCommit"]
          : null;
    const cycleId =
      typeof flags["cycle-id"] === "string"
        ? flags["cycle-id"]
        : typeof flags["cycleId"] === "string"
          ? flags["cycleId"]
          : null;
    if (since && gitCommit) {
      throw new Error("Use only one filter: --since or --git-commit.");
    }

    const result = await buildCodexSignalReport({
      root: target.root,
      store: target.storePath,
      since,
      gitCommit,
      cycleId,
    });
    const reportPath = normalizeOutputPath(target.root, result.reportPath);
    const latestPath = normalizeOutputPath(target.root, result.latestPath);
    const indexPath = normalizeOutputPath(target.root, result.indexPath);
    if (json) {
      writeJson({
        ok: true,
        report: result.report,
        telemetry_missing: result.telemetryMissing,
        telemetry_missing_reason: result.telemetryMissingReason,
        outputs: {
          report_path: reportPath,
          report_sha256: result.reportHash,
          latest_report_path: latestPath,
          latest_report_sha256: result.latestHash,
          index_path: indexPath,
          report_written: result.reportWritten,
          latest_written: result.latestWritten,
          index_written: result.indexWritten,
        },
        counts: { sessions_total: result.sessionsTotal },
      });
    } else {
      const latestLine =
        reportPath === latestPath
          ? null
          : `latest: ${latestPath}`;
      writeLines([
        formatTargetLine(target),
        "telemetry report: codex",
        `sessions: ${result.sessionsTotal}`,
        `report: ${reportPath}`,
        ...(latestLine ? [latestLine] : []),
        `index: ${indexPath}`,
      ]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
