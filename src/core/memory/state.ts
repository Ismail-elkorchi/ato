import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";

import { ensureDir, readJson, writeJson } from "../fs.js";

export type StateSnapshot = {
  id: string;
  type: "state";
  createdAt: string;
  git: {
    branch: string | null;
    head: string | null;
    status: string[];
  };
  env: {
    node: string;
    platform: string;
    cwd: string;
  };
};

export type StateSnapshotResult = {
  snapshot: StateSnapshot;
  path: string;
  latestPath: string;
};

const stateDir = (store: string): string => path.join(store, "memory", "state");

const snapshotPath = (store: string, id: string): string =>
  path.join(stateDir(store), `${id}.json`);

const latestPath = (store: string): string => path.join(stateDir(store), "latest.json");

const runGit = (root: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd: root });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
    child.on("error", () => resolve(null));
  });

const readGitStatus = async (root: string): Promise<string[]> => {
  const output = await runGit(root, ["status", "--porcelain"]);
  if (!output) return [];
  const files = output
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, "/"));
  files.sort((a, b) => a.localeCompare(b));
  return files;
};

export const writeStateSnapshot = async ({
  store,
  root,
}: {
  store: string;
  root: string;
}): Promise<StateSnapshotResult> => {
  const createdAt = new Date().toISOString();
  const id = `state-${createdAt.replace(/[:.]/g, "-")}`;
  const snapshot: StateSnapshot = {
    id,
    type: "state",
    createdAt,
    git: {
      branch: await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head: await runGit(root, ["rev-parse", "HEAD"]),
      status: await readGitStatus(root),
    },
    env: {
      node: process.version,
      platform: process.platform,
      cwd: root,
    },
  };

  await ensureDir(stateDir(store));
  const filePath = snapshotPath(store, id);
  const latest = latestPath(store);
  await writeJson(filePath, snapshot);
  await writeJson(latest, snapshot);

  return { snapshot, path: filePath, latestPath: latest };
};

export const readLatestStateSnapshot = async (
  store: string,
): Promise<StateSnapshot | null> => {
  return readJson<StateSnapshot>(latestPath(store), null);
};

export const readStateSnapshot = async ({
  store,
  id,
}: {
  store: string;
  id: string;
}): Promise<StateSnapshot | null> => {
  return readJson<StateSnapshot>(snapshotPath(store, id), null);
};

export const listStateSnapshots = async (
  store: string,
): Promise<StateSnapshot[]> => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(stateDir(store), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots: StateSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name === "latest.json") continue;
    const id = entry.name.slice(0, -".json".length);
    const snapshot = await readJson<StateSnapshot>(snapshotPath(store, id), null);
    if (snapshot) snapshots.push(snapshot);
  }
  snapshots.sort((a, b) => {
    const createdDiff = a.createdAt.localeCompare(b.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  return snapshots;
};

export const filterStateSnapshots = ({
  snapshots,
  since,
  until,
  limit,
}: {
  snapshots: StateSnapshot[];
  since?: string | null;
  until?: string | null;
  limit?: number | null;
}): StateSnapshot[] => {
  let filtered = snapshots.slice();
  if (since) {
    filtered = filtered.filter((snapshot) => snapshot.createdAt >= since);
  }
  if (until) {
    filtered = filtered.filter((snapshot) => snapshot.createdAt <= until);
  }
  if (limit && limit > 0) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
};
