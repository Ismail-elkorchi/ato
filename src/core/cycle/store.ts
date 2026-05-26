import path from "node:path";
import { promises as fs } from "node:fs";

import { appendJsonl, readJsonl } from "../fs.js";
import type { CycleRecord } from "../types.js";

export const cycleDir = (store: string): string => path.join(store, "cycles");

export const cycleLedgerPath = (store: string): string =>
  path.join(cycleDir(store), "ledger.jsonl");

export const readCycleRecords = async (store: string): Promise<CycleRecord[]> => {
  const records = await readJsonl<CycleRecord>(cycleLedgerPath(store));
  return records.map((record) => record.item).sort((a, b) => {
    const indexDiff = Number(a.cycle_index) - Number(b.cycle_index);
    if (Number.isFinite(indexDiff) && indexDiff !== 0) return indexDiff;
    return String(a.id).localeCompare(String(b.id));
  });
};

const scanCycleDirMax = async (store: string): Promise<number> => {
  try {
    const entries = await fs.readdir(cycleDir(store), { withFileTypes: true });
    return entries.reduce((max, entry) => {
      if (!entry.isDirectory()) return max;
      const match = entry.name.match(/^CY-(\d+)$/);
      if (!match) return max;
      return Math.max(max, Number(match[1]));
    }, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};

export const nextCycleIdentity = async (
  store: string,
): Promise<{ id: string; index: number }> => {
  const records = await readCycleRecords(store);
  const ledgerMax = records.reduce((max, record) => {
    const match = String(record.id ?? "").match(/^CY-(\d+)$/);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  const dirMax = await scanCycleDirMax(store);
  const index = Math.max(ledgerMax, dirMax) + 1;
  return { id: `CY-${String(index).padStart(4, "0")}`, index };
};

export const appendCycleRecord = async ({
  store,
  record,
}: {
  store: string;
  record: CycleRecord;
}): Promise<void> => {
  const existing = await readCycleRecords(store);
  if (existing.some((entry) => entry.id === record.id)) {
    throw new Error(`cycle id '${record.id}' already exists.`);
  }
  await appendJsonl(cycleLedgerPath(store), record);
};
