import path from "node:path";
import { promises as fs } from "node:fs";

import { inspectLock, type LockStatus } from "../lock.js";

export type GitLocksSnapshot = {
  ato_lock: {
    path: ".ato/lock.json";
    exists: boolean;
    current: LockStatus["current"];
    ttlMs: number;
    ageMs: number | null;
    pidRunning: boolean | null;
    stale: boolean;
  };
  git_lock: {
    path: ".git/index.lock";
    exists: boolean;
    mtime: string | null;
    ageMs: number | null;
    git_dir_kind: "directory" | "file" | "missing";
  };
};

const resolveGitDir = async (
  root: string,
): Promise<{ kind: "directory" | "file" | "missing"; gitDir: string | null }> => {
  const dotGitPath = path.join(root, ".git");
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory()) {
      return { kind: "directory", gitDir: dotGitPath };
    }
  } catch {
    // ignore; fall through to file parsing
  }

  try {
    const raw = await fs.readFile(dotGitPath, "utf8");
    const match = raw.match(/^gitdir:\s*(.+)\s*$/im);
    const gitDirRaw = match?.[1]?.trim() ?? "";
    if (!gitDirRaw) return { kind: "missing", gitDir: null };
    const resolved = path.resolve(root, gitDirRaw);
    return { kind: "file", gitDir: resolved };
  } catch {
    return { kind: "missing", gitDir: null };
  }
};

const inspectGitIndexLock = async (
  root: string,
): Promise<GitLocksSnapshot["git_lock"]> => {
  const resolved = await resolveGitDir(root);
  if (!resolved.gitDir) {
    return {
      path: ".git/index.lock",
      exists: false,
      mtime: null,
      ageMs: null,
      git_dir_kind: "missing",
    };
  }

  const lockPath = path.join(resolved.gitDir, "index.lock");
  try {
    const stat = await fs.stat(lockPath);
    return {
      path: ".git/index.lock",
      exists: true,
      mtime: stat.mtime.toISOString(),
      ageMs: Date.now() - stat.mtimeMs,
      git_dir_kind: resolved.kind,
    };
  } catch {
    return {
      path: ".git/index.lock",
      exists: false,
      mtime: null,
      ageMs: null,
      git_dir_kind: resolved.kind,
    };
  }
};

export const gatherGitLocks = async ({
  root,
  store,
  ttlMs,
}: {
  root: string;
  store: string;
  ttlMs?: number;
}): Promise<GitLocksSnapshot> => {
  const atoStatus = await inspectLock(store, ttlMs);
  const gitLock = await inspectGitIndexLock(root);
  return {
    ato_lock: {
      path: ".ato/lock.json",
      exists: atoStatus.exists,
      current: atoStatus.current,
      ttlMs: atoStatus.ttlMs,
      ageMs: atoStatus.ageMs,
      pidRunning: atoStatus.pidRunning,
      stale: atoStatus.stale,
    },
    git_lock: gitLock,
  };
};
