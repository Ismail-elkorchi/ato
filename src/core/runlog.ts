import path from "node:path";
import { appendJsonl, ensureDir } from "./fs.js";
import type { RunLogEntry } from "./types.js";

export const getRunLogPath = (store: string): string =>
  path.join(store, "runs", "runs.jsonl");

export const appendRunLog = async (
  store: string,
  entry: RunLogEntry,
): Promise<void> => {
  const logPath = getRunLogPath(store);
  await ensureDir(path.dirname(logPath));
  await appendJsonl(logPath, entry);
};

export const getArtifactsDir = (
  store: string,
  queueId: string | null,
  kind: string | null,
): string => {
  const base = path.join(store, "runs", "artifacts");
  const scope = queueId ? queueId : "global";
  const group = kind ? kind : "run";
  return path.join(base, scope, group);
};
