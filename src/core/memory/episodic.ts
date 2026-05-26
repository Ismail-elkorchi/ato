import path from "node:path";

import { readJson, readJsonl, writeJson } from "../fs.js";
import { getRunLogPath } from "../runlog.js";
import type { RunLogCommand, RunLogEntry } from "../types.js";

export type EpisodicOutcome = "ok" | "fail" | "unknown";

export type EpisodicEntry = {
  id: string;
  ts: string;
  kind: string;
  summary?: string;
  queueId?: string;
  commands?: RunLogCommand[];
  outcome: EpisodicOutcome;
};

export type EpisodicIndex = {
  version: number;
  generatedAt: string;
  source: { path: string; count: number };
  entries: EpisodicEntry[];
};

export type EpisodicQuery = {
  after?: string | null;
  before?: string | null;
  kind?: string | null;
  command?: string | null;
  outcome?: EpisodicOutcome | null;
  limit?: number | null;
};

const INDEX_VERSION = 1;

const episodicDir = (store: string): string => path.join(store, "memory", "episodic");

export const episodicIndexPath = (store: string): string =>
  path.join(episodicDir(store), "index.json");

const computeOutcome = (entry: RunLogEntry): EpisodicOutcome => {
  if (!entry.commands || entry.commands.length === 0) {
    return "unknown";
  }
  return entry.commands.every((cmd) => cmd.exitCode === 0) ? "ok" : "fail";
};

export const buildEpisodicIndex = async ({
  store,
}: {
  store: string;
}): Promise<EpisodicIndex> => {
  const runLogPath = getRunLogPath(store);
  const records = await readJsonl<RunLogEntry>(runLogPath);
  const entries: EpisodicEntry[] = records.map((record) => {
    const base: EpisodicEntry = {
      id: `run-${record.line}`,
      ts: record.item.ts,
      kind: record.item.kind,
      outcome: computeOutcome(record.item),
    };
    if (typeof record.item.summary === "string") {
      base.summary = record.item.summary;
    }
    if (typeof record.item.queue_id === "string") {
      base.queueId = record.item.queue_id;
    }
    if (Array.isArray(record.item.commands)) {
      base.commands = record.item.commands;
    }
    return base;
  });

  entries.sort((a, b) => {
    const tsDiff = a.ts.localeCompare(b.ts);
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });

  const index: EpisodicIndex = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    source: { path: runLogPath, count: records.length },
    entries,
  };

  await writeJson(episodicIndexPath(store), index);
  return index;
};

export const readEpisodicIndex = async (
  store: string,
): Promise<EpisodicIndex | null> =>
  readJson<EpisodicIndex>(episodicIndexPath(store), null);

export const queryEpisodic = ({
  index,
  query,
}: {
  index: EpisodicIndex;
  query: EpisodicQuery;
}): EpisodicEntry[] => {
  let entries = index.entries.slice();

  const after = query.after ?? null;
  if (after) {
    entries = entries.filter((entry) => entry.ts >= after);
  }
  const before = query.before ?? null;
  if (before) {
    entries = entries.filter((entry) => entry.ts <= before);
  }
  if (query.kind) {
    entries = entries.filter((entry) => entry.kind === query.kind);
  }
  if (query.outcome) {
    entries = entries.filter((entry) => entry.outcome === query.outcome);
  }
  if (query.command) {
    entries = entries.filter((entry) =>
      (entry.commands ?? []).some((cmd) => cmd.cmd.includes(query.command ?? "")),
    );
  }

  if (query.limit && query.limit > 0) {
    entries = entries.slice(0, query.limit);
  }

  return entries;
};
