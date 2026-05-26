import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext, ensureProtocol } from "./shared.js";
import { inspectLock, releaseLock } from "../../core/lock.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato lock status|clear [options]",
  "",
  "Subcommands:",
  "  status               Show lock status and staleness",
  "  clear                Clear a stale lock (requires --force)",
  "",
  "Options (clear):",
  "  --force              Allow clearing stale/missing locks",
  "",
  "Examples:",
  "  ato --repo /path/to/repo lock status --json",
  "  ato --repo /path/to/repo lock clear --force --json",
].join("\n");

const formatAge = (ageMs: number | null): string =>
  ageMs === null ? "unknown" : `${Math.round(ageMs / 1000)}s`;

const LOCK_PATH_DISPLAY = ".ato/lock.json";

const buildSuggestedCommands = (): string[] => [
  "ato lock status --json",
  "ato lock clear --force --json",
];

export const runLockCommand = async ({
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

  if (subcommand === "status") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const status = await inspectLock(target.storePath, target.config.lock?.ttlMs);
    const suggested = buildSuggestedCommands();
    const redactedStatus = { ...status, lockPath: LOCK_PATH_DISPLAY };
    if (json) {
      writeJson({
        ok: true,
        status: { ...redactedStatus, suggested_commands: suggested },
      });
    } else {
      writeLines([
        formatTargetLine(target),
        `lock: ${redactedStatus.exists ? "present" : "none"}`,
        `path: ${redactedStatus.lockPath}`,
        `pid: ${redactedStatus.current?.pid ?? "unknown"}`,
        `age: ${formatAge(redactedStatus.ageMs)}`,
        `stale: ${redactedStatus.stale ? "yes" : "no"}`,
        `next: ${suggested[0]}`,
        `clear: ${suggested[1]}`,
      ]);
    }
    return;
  }

  if (subcommand === "clear") {
    if (!flags["force"]) {
      throw new Error("Missing required --force.");
    }
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const status = await inspectLock(target.storePath, target.config.lock?.ttlMs);
    const suggested = buildSuggestedCommands();
    const redactedStatus = { ...status, lockPath: LOCK_PATH_DISPLAY };
    if (!status.exists) {
      if (json) {
        writeJson({
          ok: true,
          cleared: false,
          status: { ...redactedStatus, suggested_commands: suggested },
        });
      } else {
        writeLines([formatTargetLine(target), "lock: none"]);
      }
      return;
    }
    if (status.pidRunning === true || !status.stale) {
      const error = new Error("Lock is active; refusing to clear.");
      (error as Error & { code?: number; details?: unknown }).code = 2;
      (error as Error & { details?: unknown }).details = {
        status: redactedStatus,
        suggested_commands: suggested,
      };
      throw error;
    }
    await releaseLock(status.lockPath);
    if (json) {
      writeJson({
        ok: true,
        cleared: true,
        status: {
          ...redactedStatus,
          exists: false,
          suggested_commands: suggested,
        },
      });
    } else {
      writeLines([formatTargetLine(target), "lock: cleared"]);
    }
    return;
  }

  if (json) {
    writeJson({ ok: false, code: 1, error: { message: "Unknown lock subcommand." } });
  } else {
    writeLines(["Unknown lock subcommand.", "Usage: ato lock status|clear"]);
  }
  process.exitCode = 1;
};
