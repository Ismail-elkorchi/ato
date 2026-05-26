import path from "node:path";

import { ensureDir, readJson, writeJson } from "../fs.js";

export type WorkingSnapshot = {
  id: string;
  type: "working";
  createdAt: string;
  summary: string;
  summaryLength: number;
  truncated: boolean;
};

export type WorkingSnapshotResult = {
  snapshot: WorkingSnapshot;
  path: string;
  latestPath: string;
};

const MAX_SUMMARY_CHARS = 4000;

const sanitizeSummary = (
  value: string,
): { summary: string; truncated: boolean } => {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_SUMMARY_CHARS) {
    return { summary: trimmed, truncated: false };
  }
  return {
    summary: trimmed.slice(0, MAX_SUMMARY_CHARS),
    truncated: true,
  };
};

const workingDir = (store: string): string => path.join(store, "memory", "working");

const snapshotPath = (store: string, id: string): string =>
  path.join(workingDir(store), `${id}.json`);

const latestPath = (store: string): string => path.join(workingDir(store), "latest.json");

export const writeWorkingSnapshot = async ({
  store,
  summary,
}: {
  store: string;
  summary: string;
}): Promise<WorkingSnapshotResult> => {
  const createdAt = new Date().toISOString();
  const id = `working-${createdAt.replace(/[:.]/g, "-")}`;
  const normalized = sanitizeSummary(summary);
  const snapshot: WorkingSnapshot = {
    id,
    type: "working",
    createdAt,
    summary: normalized.summary,
    summaryLength: normalized.summary.length,
    truncated: normalized.truncated,
  };

  await ensureDir(workingDir(store));
  const filePath = snapshotPath(store, id);
  const latest = latestPath(store);
  await writeJson(filePath, snapshot);
  await writeJson(latest, snapshot);

  return { snapshot, path: filePath, latestPath: latest };
};

export const readLatestWorkingSnapshot = async (
  store: string,
): Promise<WorkingSnapshot | null> => {
  return readJson<WorkingSnapshot>(latestPath(store), null);
};
