import { spawnSync } from "node:child_process";

export type GitStatusSnapshot = {
  dirty: boolean;
  status_sb: string | null;
  dirty_paths: string[];
  tracked_paths: string[];
  untracked_paths: string[];
  staged_paths: string[];
  unstaged_paths: string[];
  status_error: string | null;
  porcelain_error: string | null;
  optional_locks: {
    strategy: "env";
    env_var: "GIT_OPTIONAL_LOCKS";
    value: "0";
  };
};

const OPTIONAL_LOCKS_ENV = {
  strategy: "env" as const,
  env_var: "GIT_OPTIONAL_LOCKS" as const,
  value: "0" as const,
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const normalizeDirtyPath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const posix = toPosixPath(trimmed);
  return posix.startsWith(".") ? posix.slice(1) : posix;
};

type ParsedGitPaths = {
  dirty_paths: string[];
  tracked_paths: string[];
  untracked_paths: string[];
  staged_paths: string[];
  unstaged_paths: string[];
};

const parsePorcelainV1Z = (stdout: string): ParsedGitPaths => {
  const parts = stdout.split("\0").filter((entry) => entry.length > 0);
  const dirtyPaths = new Set<string>();
  const trackedPaths = new Set<string>();
  const untrackedPaths = new Set<string>();
  const stagedPaths = new Set<string>();
  const unstagedPaths = new Set<string>();

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const stagedCode = status[0] ?? " ";
    const unstagedCode = status[1] ?? " ";
    const firstPath = entry.slice(3);
    const renamedOrCopied =
      status.includes("R") || status.includes("C");

    let candidate = firstPath;
    if (renamedOrCopied) {
      const nextPath = parts[i + 1] ?? "";
      if (nextPath.trim()) {
        candidate = nextPath;
        i += 1;
      }
    }

    const normalized = normalizeDirtyPath(candidate);
    if (!normalized) continue;

    dirtyPaths.add(normalized);
    if (status === "??") {
      untrackedPaths.add(normalized);
      continue;
    }

    trackedPaths.add(normalized);
    if (stagedCode !== " " && stagedCode !== "?") {
      stagedPaths.add(normalized);
    }
    if (unstagedCode !== " " && unstagedCode !== "?") {
      unstagedPaths.add(normalized);
    }
  }

  const sortPaths = (paths: Set<string>): string[] =>
    [...paths].sort((a, b) => a.localeCompare(b));

  return {
    dirty_paths: sortPaths(dirtyPaths),
    tracked_paths: sortPaths(trackedPaths),
    untracked_paths: sortPaths(untrackedPaths),
    staged_paths: sortPaths(stagedPaths),
    unstaged_paths: sortPaths(unstagedPaths),
  };
};

const runGitReadOnly = (root: string, args: string[]) =>
  spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: OPTIONAL_LOCKS_ENV.value,
    },
  });

export const gatherGitStatus = (root: string): GitStatusSnapshot => {
  const status = runGitReadOnly(root, ["status", "-sb"]);
  const porcelain = runGitReadOnly(root, ["status", "--porcelain=v1", "-z"]);

  const statusLines =
    status.status === 0 && !status.error
      ? status.stdout.trim().split(/\r?\n/).filter(Boolean)
      : [];
  const parsedPaths =
    porcelain.status === 0 && !porcelain.error
      ? parsePorcelainV1Z(porcelain.stdout)
      : {
          dirty_paths: [],
          tracked_paths: [],
          untracked_paths: [],
          staged_paths: [],
          unstaged_paths: [],
        };
  const dirty =
    statusLines.length > 1 ||
    parsedPaths.dirty_paths.length > 0 ||
    status.status !== 0 ||
    Boolean(status.error) ||
    porcelain.status !== 0 ||
    Boolean(porcelain.error);

  return {
    dirty,
    status_sb: status.status === 0 ? status.stdout.trimEnd() : null,
    dirty_paths: parsedPaths.dirty_paths,
    tracked_paths: parsedPaths.tracked_paths,
    untracked_paths: parsedPaths.untracked_paths,
    staged_paths: parsedPaths.staged_paths,
    unstaged_paths: parsedPaths.unstaged_paths,
    status_error:
      status.status === 0
        ? null
        : status.stderr.trim() || status.error?.message || "git status failed.",
    porcelain_error:
      porcelain.status === 0
        ? null
        : porcelain.stderr.trim() ||
          porcelain.error?.message ||
          "git status porcelain failed.",
    optional_locks: OPTIONAL_LOCKS_ENV,
  };
};
