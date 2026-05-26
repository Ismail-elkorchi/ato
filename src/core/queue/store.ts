import path from "node:path";

import { readJsonl, writeJsonl } from "../fs.js";
import { normalizeTarget } from "./transitions.js";
import type { JsonlRecord, QueueItem } from "../types.js";

export const getQueuePaths = (store: string) => {
  const queueDir = path.join(store, "queue");
  return {
    queueDir,
    itemsPath: path.join(queueDir, "items.jsonl"),
    releasePath: path.join(queueDir, "release.json"),
    viewsDir: path.join(queueDir, "views"),
  };
};

export const readQueueItems = async (
  store: string,
): Promise<Array<JsonlRecord<QueueItem>>> => {
  const { itemsPath } = getQueuePaths(store);
  return readJsonl(itemsPath);
};

export const writeQueueItems = async (
  store: string,
  items: QueueItem[],
): Promise<void> => {
  const { itemsPath } = getQueuePaths(store);
  await writeJsonl(itemsPath, items);
};

export const nextQueueId = (
  records: Array<JsonlRecord<QueueItem> | QueueItem>,
): string => {
  let max = 0;
  for (const record of records) {
    const item =
      "item" in record ? record.item : record;
    const match = String(item?.id ?? "").match(
      /^BL-(\d+)$/,
    );
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      max = Math.max(max, value);
    }
  }
  const next = max + 1;
  const padded = String(next).padStart(4, "0");
  return `BL-${padded}`;
};

export const normalizeQueueTargets = (item: QueueItem | null): QueueItem | null => {
  if (!item) return item;
  return {
    ...item,
    target: normalizeTarget(item.target),
  };
};
