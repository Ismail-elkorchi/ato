import { spawnSync } from "node:child_process";

type ProtectedBlockChange = {
  path: string;
  reason: string;
};

const BLOCK_DIR = ".ato/meta/blocks";

const runGit = (root: string, args: string[]) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

const readGitFile = (root: string, filePath: string): string | null => {
  const result = runGit(root, ["show", `HEAD:${filePath}`]);
  if (result.status !== 0) return null;
  const output = String(result.stdout ?? "");
  return output.length ? output : null;
};

const isFrozenBlock = (raw: string): boolean | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed?.["frozen"] === true;
  } catch {
    return null;
  }
};

const isUnderBlockDir = (filePath: string): boolean =>
  filePath.replace(/\\/g, "/").startsWith(`${BLOCK_DIR}/`);

export const findProtectedBlockChanges = async ({
  root,
}: {
  root: string;
}): Promise<{
  changes: ProtectedBlockChange[];
  error: string | null;
}> => {
  const diff = runGit(root, ["diff", "--name-only"]);
  if (diff.status !== 0) {
    const stderr = diff.stderr.trim().toLowerCase();
    if (stderr.includes("not a git repository")) {
      return { changes: [], error: null };
    }
    return {
      changes: [],
      error: diff.stderr.trim() || "git diff failed.",
    };
  }

  const paths = diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const changes: ProtectedBlockChange[] = [];
  for (const filePath of paths) {
    if (!isUnderBlockDir(filePath)) continue;
    if (filePath.endsWith(".closure.json")) {
      if (readGitFile(root, filePath)) {
        changes.push({ path: filePath, reason: "closure_modified" });
      }
      continue;
    }
    if (filePath.endsWith(".seal.json")) {
      if (readGitFile(root, filePath)) {
        changes.push({ path: filePath, reason: "seal_modified" });
      }
      continue;
    }
    if (!filePath.endsWith(".json")) continue;
    const raw = readGitFile(root, filePath);
    if (!raw) continue;
    const frozen = isFrozenBlock(raw);
    if (frozen === true) {
      changes.push({ path: filePath, reason: "frozen_block_modified" });
    } else if (frozen === null) {
      changes.push({ path: filePath, reason: "block_parse_failed" });
    }
  }

  return { changes, error: null };
};
