import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { runDevServer } from "../../core/dev/runner.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato dev run --command <cmd> --url <url> [options]",
  "",
  "Options:",
  "  --command <cmd>    Command to run (required)",
  "  --url <url>        Readiness URL (required)",
  "  --timeout <ms>     Readiness timeout (default: 60000)",
  "  --interval <ms>    Readiness poll interval (default: 500)",
  "",
  "Examples:",
  "  ato dev run --command \"npm run dev\" --url http://localhost:3000",
].join("\n");

export const runDevCommand = async ({
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
      writeJson({ ok: false, code: 1, error: { message: "Unknown dev subcommand." } });
    } else {
      writeLines(["Unknown dev subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const command = typeof flags["command"] === "string" ? flags["command"] : null;
  const url = typeof flags["url"] === "string" ? flags["url"] : null;
  if (!command) throw new Error("Missing --command.");
  if (!url) throw new Error("Missing --url.");

  const timeoutMs = Number(flags["timeout"] ?? 60000);
  const intervalMs = Number(flags["interval"] ?? 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid --timeout value.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Invalid --interval value.");
  }

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const artifactsDir = getArtifactsDir(target.storePath, null, "dev");
    const result = await runDevServer({
      root: target.root,
      command,
      url,
      timeoutMs,
      intervalMs,
      artifactsDir,
    });

    await appendRunLog(target.storePath, {
      ts: new Date().toISOString(),
      kind: "dev_run",
      target_id: target.id,
      commands: [
        {
          cmd: command,
          cwd: target.root,
          exitCode: result.exitCode ?? 1,
          durationMs: result.durationMs,
        },
      ],
      artifacts: result.logPath ? [result.logPath] : [],
      summary: `dev run ${result.ok ? "ok" : "fail"}`,
    });

    if (json) {
      writeJson({
        ok: result.ok,
        url: result.url,
        ready: result.ready,
        pid: result.pid,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        error: result.errorType
          ? { type: result.errorType, message: result.errorMessage }
          : null,
      });
    } else {
      const lines = [
        formatTargetLine(target),
        `dev run: ${result.ok ? "ok" : "fail"}`,
        `command: ${command}`,
        `url: ${result.url}`,
        `ready: ${result.ready ? "yes" : "no"}`,
        result.pid ? `pid: ${result.pid}` : "pid: none",
        result.logPath ? `logs: ${result.logPath}` : "logs: none",
        result.errorMessage ? `error: ${result.errorMessage}` : null,
      ];
      writeLines(lines);
    }

    if (!result.ok) {
      process.exitCode = result.errorType === "timeout" ? 4 : 1;
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
