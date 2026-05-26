import { resolveTarget, TargetError } from "../../core/targets/resolve.js";
import { checkProtocolCompatibility } from "../../core/protocol.js";
import { acquireLock, inspectLock, releaseLock } from "../../core/lock.js";
import { ensureDir } from "../../core/fs.js";
import { crossStoreAllowStatus } from "../../core/cross-store.js";
import type { CommandContext } from "../types.js";
import type { TargetContext } from "../../core/types.js";

export const resolveTargetContext = async ({
  context,
  requireWrite,
}: {
  context: CommandContext;
  requireWrite: boolean;
}): Promise<TargetContext> => {
  const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
  const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
  const { target } = await resolveTarget({
    cwd: process.cwd(),
    selection,
    storeSelection,
    requireWrite,
  });
  return target;
};

export const ensureProtocol = async (
  root: string,
): Promise<Awaited<ReturnType<typeof checkProtocolCompatibility>>> => {
  const result = await checkProtocolCompatibility(root);
  if (!result.ok) {
    const error = new Error("Protocol compatibility check failed.");
    (error as Error & { code?: number; details?: unknown }).code = 5;
    (error as Error & { details?: unknown }).details = result;
    throw error;
  }
  return result;
};

export const acquireWriteLock = async (
  target: TargetContext,
  ttlMs?: number,
): Promise<string> => {
  await ensureDir(target.storePath);
  const lock = await acquireLock(target.storePath, ttlMs);
  if (lock.ok) return lock.lockPath;

  const bypassPid = process.env["ATO_LOCK_BYPASS_PID"];
  if (bypassPid && lock.current && String(lock.current.pid) === bypassPid) {
    const status = await inspectLock(target.storePath, ttlMs);
    if (status.exists && !status.stale && status.current) {
      if (String(status.current.pid) === bypassPid) {
        return lock.lockPath;
      }
    }
  }

  if (process.env["ATO_LOCK_TEST_REMOVE_BEFORE_STATUS"] === "1") {
    await releaseLock(lock.lockPath);
  }

  let status = await inspectLock(target.storePath, ttlMs);
  let retried = false;
  if (status.exists && status.stale && status.pidRunning === false) {
    await releaseLock(status.lockPath);
    const retry = await acquireLock(target.storePath, ttlMs);
    retried = true;
    if (retry.ok) return retry.lockPath;
    status = await inspectLock(target.storePath, ttlMs);
  }

  if (!status.exists && !retried) {
    const retry = await acquireLock(target.storePath, ttlMs);
    if (retry.ok) return retry.lockPath;
    status = await inspectLock(target.storePath, ttlMs);
    if (!status.exists) {
      return retry.lockPath;
    }
  }

  const suggestedCommands = [
    "ato lock status --json",
    "ato lock clear --force --json",
  ];
  const example = suggestedCommands[0];
  const redactedStatus = { ...status, lockPath: ".ato/lock.json" };
  const error = new TargetError(
    `Repo store is locked by another process. Example: ${example}`,
    {
      lockPath: ".ato/lock.json",
      lock: lock.current,
      status: redactedStatus,
      suggested_commands: suggestedCommands,
    },
  );
  throw error;
};

export const releaseWriteLock = async (lockPath: string | null): Promise<void> => {
  await releaseLock(lockPath);
};

export const ensureCrossStoreWriteAllowed = async ({
  sourceTarget,
  destTarget,
  allowFlag,
  command,
}: {
  sourceTarget: TargetContext;
  destTarget: TargetContext;
  allowFlag: boolean;
  command: string;
}): Promise<void> => {
  if (sourceTarget.root === destTarget.root) return;

  const status = await crossStoreAllowStatus(sourceTarget, destTarget);
  if (allowFlag && status.allowed) return;

  const configExample = {
    version: 1,
    allowlist: [{ root: destTarget.root, id: destTarget.id }],
  };
  const error = new Error(
    "Cross-store write blocked by default. Configure .ato/cross-store.json in both repos and re-run with --allow-cross-store-write.",
  );
  (error as Error & { code?: number; details?: unknown }).code = 1;
  (error as Error & { details?: unknown }).details = {
    command,
    allow_flag: allowFlag,
    source: {
      id: sourceTarget.id,
      root: sourceTarget.root,
      config_path: status.sourceConfigPath,
      allowed: status.sourceAllowed,
    },
    destination: {
      id: destTarget.id,
      root: destTarget.root,
      config_path: status.destConfigPath,
      allowed: status.destAllowed,
    },
    config_example: configExample,
    guidance: [
      `Create ${status.sourceConfigPath} and ${status.destConfigPath} with allowlist entries for each other.`,
      "Re-run with --allow-cross-store-write.",
    ],
  };
  throw error;
};
