import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { stableStringify } from "../fs.js";
import { getArtifactsDir } from "../runlog.js";
import {
  buildBlackboardSignals,
  loadSignalCatalog,
  normalizeBlackboardObservations,
  renderCommandLog,
  sortBlackboardSignals,
} from "./refresh.js";
import type {
  BlackboardCommandResult,
  BlackboardObservation,
} from "./refresh.js";
import type { BlackboardSignal } from "../types.js";

type CommandResult = {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  commandLine: string;
};

export type BlackboardView = {
  generated_at: string;
  signals: BlackboardSignal[];
  commands: Array<{
    signal: string;
    cmd: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
  }>;
  artifacts: {
    command_log_path: string | null;
  };
};

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const toRelativePath = (root: string, filePath: string): string => {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return toPosix(rel);
};

const runCommand = async ({
  cmd,
  cwd,
}: {
  cmd: string[];
  cwd: string;
}): Promise<CommandResult> => {
  const [bin, ...args] = cmd;
  if (!bin) {
    return {
      ok: false,
      exitCode: 1,
      durationMs: 0,
      stdout: "",
      stderr: "Missing command.",
      commandLine: "",
    };
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code: number | null) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        commandLine: [bin, ...args].join(" "),
      });
    });
  });
};

const resolveArtifactsPath = ({
  store,
  fallbackName,
  artifactPath,
}: {
  store: string;
  fallbackName: string;
  artifactPath?: string | null;
}): string => {
  if (artifactPath) return artifactPath;
  const dir = getArtifactsDir(store, null, "bb");
  return path.join(dir, fallbackName);
};

const STABLE_TIMESTAMP_BASE = Date.UTC(2000, 0, 1);
const STABLE_TIMESTAMP_RANGE_MS = 1000 * 60 * 60 * 24 * 365 * 50;

const buildDeterministicTimestamp = ({
  root,
  commands,
  cycleId,
}: {
  root: string;
  commands: BlackboardCommandResult[];
  cycleId: string | null;
}): Date => {
  const signature = {
    cycle_id: cycleId,
    commands: commands.map((command) => ({
      signal: command.signal,
      cmd: command.commandLine,
      cwd: toRelativePath(root, command.cwd),
      exitCode: command.exitCode,
    })),
  };
  const seed = stableStringify(signature);
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const offset =
    parseInt(hash.slice(0, 12), 16) % STABLE_TIMESTAMP_RANGE_MS;
  return new Date(STABLE_TIMESTAMP_BASE + offset);
};

export const buildBlackboardView = async ({
  root,
  store,
  observations,
  cycleId,
  artifactPath,
  deterministic = false,
  now,
  readOnly = false,
}: {
  root: string;
  store: string;
  observations: BlackboardObservation[];
  cycleId?: string | null;
  artifactPath?: string | null;
  deterministic?: boolean;
  now?: Date;
  readOnly?: boolean;
}): Promise<BlackboardView> => {
  const catalog = await loadSignalCatalog(store);
  const catalogRel = toRelativePath(root, catalog.catalogPath);
  if (!catalog.ok) {
    const error = new Error("Invalid signal definition catalog.");
    (error as Error & { code?: number; details?: unknown }).code = 3;
    (error as Error & { details?: unknown }).details = {
      catalog_path: catalogRel,
      errors: catalog.errors,
    };
    throw error;
  }

  const normalized = normalizeBlackboardObservations({
    observations,
    catalogSignals: catalog.catalogSignals,
  });
  if (normalized.errors.length) {
    const error = new Error("Invalid blackboard observations.");
    (error as Error & { code?: number; details?: unknown }).code = 3;
    (error as Error & { details?: unknown }).details = {
      catalog_path: catalogRel,
      errors: normalized.errors,
      catalog_signals: catalog.catalogSignals,
    };
    throw error;
  }

  const commandResults: BlackboardCommandResult[] = [];
  const commandSummaries: Array<{
    signal: string;
    cmd: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
  }> = [];

  for (const observation of normalized.observations) {
    const cwd = observation.cwd
      ? path.resolve(root, observation.cwd)
      : root;
    const result = await runCommand({ cmd: observation.cmd, cwd });
    const cwdRel = toRelativePath(root, cwd);
    commandResults.push({
      signal: observation.signal,
      commandLine: result.commandLine,
      cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ok: result.ok,
    });
    commandSummaries.push({
      signal: observation.signal,
      cmd: result.commandLine,
      cwd: cwdRel,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  }

  const logStamp = new Date();
  let artifactRel = "";
  let commandLogPath: string | null = null;
  if (!readOnly) {
    const resolvedArtifactPath = resolveArtifactsPath({
      store,
      fallbackName: `bb-${logStamp.getTime()}.log`,
      artifactPath: artifactPath ?? null,
    });
    await fs.mkdir(path.dirname(resolvedArtifactPath), { recursive: true });
    artifactRel = toRelativePath(root, resolvedArtifactPath);
    commandLogPath = artifactRel;
    const artifactContent = renderCommandLog(commandResults);
    await fs.writeFile(resolvedArtifactPath, artifactContent, "utf8");
  }

  const effectiveNow =
    now ??
    (deterministic
      ? buildDeterministicTimestamp({
          root,
          commands: commandResults,
          cycleId: cycleId ?? null,
        })
      : logStamp);

  const commandSignals = buildBlackboardSignals({
    results: commandResults,
    artifactRel,
    now: effectiveNow,
  });

  const signals = sortBlackboardSignals(commandSignals);

  return {
    generated_at: effectiveNow.toISOString(),
    signals,
    commands: commandSummaries,
    artifacts: {
      command_log_path: commandLogPath,
    },
  };
};
