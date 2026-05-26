import {
  parseFlags,
  writeJson,
  writeLines,
  formatTargetLine,
} from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { runTracedCommand } from "../../core/trace/index.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { readState } from "../../core/state.js";
import type { RunLogEntry } from "../../core/types.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato trace run --command <cmd> [options]",
  "",
  "Options:",
  "  --command <cmd>       Command to run (required)",
  "  --categories <a,b>    Comma-delimited categories to record",
  "",
  "Examples:",
  "  ato trace run --command \"npm test\"",
  "  ato trace run --command \"npm test\" --categories trace,command",
].join("\n");

const parseCategories = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

export const runTraceCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand !== "run") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown trace subcommand." },
      });
    } else {
      writeLines(["Unknown trace subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const command = typeof flags["command"] === "string" ? flags["command"] : null;
  if (!command) throw new Error("Missing --command.");
  if (flags["categories"] === true) {
    throw new Error("Missing --categories value.");
  }
  const categories =
    typeof flags["categories"] === "string"
      ? parseCategories(flags["categories"])
      : [];

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const state = await readState(target.storePath);
    const queueId = state.activeQueueId ?? null;
    const artifactsDir = getArtifactsDir(target.storePath, queueId, "trace");
    const result = await runTracedCommand({
      root: target.root,
      command,
      categories,
      artifactsDir,
      stdio: json ? "ignore" : "inherit",
    });

    const runLogEntry: RunLogEntry = {
      ts: new Date().toISOString(),
      kind: "trace",
      target_id: target.id,
      commands: [
        {
          cmd: command,
          cwd: target.root,
          exitCode: result.exitCode ?? 1,
          durationMs: result.durationMs,
        },
      ],
      artifacts: result.tracePath ? [result.tracePath] : [],
      summary: `trace run ${result.ok ? "ok" : "fail"}`,
    };
    if (queueId) {
      runLogEntry.queue_id = queueId;
    }
    await appendRunLog(target.storePath, runLogEntry);

    if (json) {
      writeJson({
        ok: result.ok,
        tracePath: result.tracePath,
        error: result.error,
        trace: result.trace,
      });
    } else {
      const filterLabel = result.trace.filters.categories?.length
        ? result.trace.filters.categories.join(",")
        : "all";
      writeLines([
        formatTargetLine(target),
        `trace run: ${result.ok ? "ok" : "fail"}`,
        `command: ${command}`,
        `categories: ${filterLabel}`,
        `events: ${result.trace.events.length}`,
        `duration: ${result.durationMs}ms`,
        result.tracePath ? `trace: ${result.tracePath}` : "trace: none",
        result.error?.message ? `error: ${result.error.message}` : null,
      ]);
    }

    if (!result.ok) {
      process.exitCode = result.exitCode && result.exitCode > 0 ? result.exitCode : 1;
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
