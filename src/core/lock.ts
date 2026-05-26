import { promises as fs } from "node:fs";
import path from "node:path";

import { fileExists, readJson } from "./fs.js";

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

type LockPayload = {
  pid: number;
  created_at: string;
};

export type LockStatus = {
  lockPath: string;
  exists: boolean;
  current: LockPayload | null;
  ttlMs: number;
  ageMs: number | null;
  pidRunning: boolean | null;
  stale: boolean;
};

const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const getLockPath = (store: string): string =>
  path.join(store, "lock.json");

export const acquireLock = async (
  store: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ ok: boolean; lockPath: string; current?: LockPayload | null }> => {
  const lockPath = getLockPath(store);
  const now = Date.now();

  if (await fileExists(lockPath)) {
    const current = await readJson<LockPayload>(lockPath, null);
    const createdAt = current?.created_at
      ? Date.parse(current.created_at)
      : null;
    const pidRunning =
      current && Number.isInteger(current.pid) ? isPidRunning(current.pid) : null;
    const staleByPid = pidRunning === false;
    const staleByAge = createdAt ? now - createdAt > ttlMs : false;
    if (staleByPid || staleByAge) {
      return { ok: false, lockPath, current };
    }
    return { ok: false, lockPath, current };
  }

  const payload: LockPayload = {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  try {
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), {
      flag: "wx",
    });
  } catch {
    return { ok: false, lockPath, current: payload };
  }

  return { ok: true, lockPath };
};

export const releaseLock = async (lockPath: string | null): Promise<void> => {
  if (!lockPath) return;
  await fs.rm(lockPath, { force: true });
};

export const inspectLock = async (
  store: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<LockStatus> => {
  const lockPath = getLockPath(store);
  if (!(await fileExists(lockPath))) {
    return {
      lockPath,
      exists: false,
      current: null,
      ttlMs,
      ageMs: null,
      pidRunning: null,
      stale: false,
    };
  }
  const current = await readJson<LockPayload>(lockPath, null);
  const createdAt = current?.created_at ? Date.parse(current.created_at) : null;
  const ageMs = createdAt ? Date.now() - createdAt : null;
  const pidRunning =
    current && Number.isInteger(current.pid) ? isPidRunning(current.pid) : null;
  const staleByAge = ageMs !== null && ageMs > ttlMs;
  const staleByPid = pidRunning === false;
  return {
    lockPath,
    exists: true,
    current,
    ttlMs,
    ageMs,
    pidRunning,
    stale: staleByAge || staleByPid,
  };
};
