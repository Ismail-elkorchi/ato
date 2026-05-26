import path from "node:path";
import { promises as fs } from "node:fs";

import { readJson } from "../fs.js";

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const BLOCK_ID_RE = /^block-(\d{4,})$/;

const toBlockId = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return BLOCK_ID_RE.test(trimmed) ? trimmed : null;
};

const parseBlockNumber = (blockId: string): number | null => {
  const match = blockId.match(BLOCK_ID_RE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const compareBlockIds = (left: string, right: string): number => {
  const leftNum = parseBlockNumber(left);
  const rightNum = parseBlockNumber(right);
  if (leftNum !== null && rightNum !== null && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  if (leftNum !== null && rightNum === null) return -1;
  if (leftNum === null && rightNum !== null) return 1;
  return left.localeCompare(right);
};

const formatBlockId = (value: number): string => {
  const safe = Math.max(0, Math.trunc(value));
  const digits = String(safe);
  const width = Math.max(4, digits.length);
  return `block-${digits.padStart(width, "0")}`;
};

export const listBlockFiles = async (store: string): Promise<string[]> => {
  const dir = path.join(store, "meta", "blocks");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .filter(
        (name) => !name.endsWith(".seal.json") && !name.endsWith(".closure.json"),
      )
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const listBlockIds = async (store: string): Promise<string[]> => {
  const files = await listBlockFiles(store);
  const ids = files
    .map((name) => (name.endsWith(".json") ? name.slice(0, -5) : name))
    .map((name) => toBlockId(name))
    .filter((name): name is string => Boolean(name));
  const unique = [...new Set(ids)];
  unique.sort(compareBlockIds);
  return unique;
};

const listClosedBlockIds = async (store: string): Promise<Set<string>> => {
  const dir = path.join(store, "meta", "blocks");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".closure.json"))
      .map((entry) => entry.name.slice(0, -".closure.json".length))
      .map((name) => toBlockId(name))
      .filter((name): name is string => Boolean(name));
    return new Set(ids);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
};

export type BlockState = {
  block_ids: string[];
  active_block_id: string | null;
  next_block_id: string;
};

export const resolveBlockState = async (store: string): Promise<BlockState> => {
  const blockIds = await listBlockIds(store);
  const closed = await listClosedBlockIds(store);
  const openIds = blockIds.filter((id) => !closed.has(id));
  openIds.sort(compareBlockIds);
  const activeBlockId = openIds.length
    ? openIds[openIds.length - 1] ?? null
    : null;

  const numbers = blockIds
    .map((id) => parseBlockNumber(id))
    .filter((value): value is number => Number.isFinite(value));
  const max = numbers.length ? Math.max(...numbers) : 0;
  const nextBlockId = formatBlockId(max + 1);

  return {
    block_ids: blockIds,
    active_block_id: activeBlockId,
    next_block_id: nextBlockId,
  };
};

export const loadBlockConfig = async (
  store: string,
  blockId?: string | null,
): Promise<Record<string, unknown> | null> => {
  if (blockId) {
    const candidate = path.join(store, "meta", "blocks", `${blockId}.json`);
    const block = await readJson<Record<string, unknown> | null>(candidate, null);
    if (block) return block;
  }
  const files = await listBlockFiles(store);
  if (!files.length) return null;
  const latest = files[files.length - 1];
  if (!latest) return null;
  return readJson<Record<string, unknown> | null>(
    path.join(store, "meta", "blocks", latest),
    null,
  );
};

export const resolveBlockId = (block: unknown): string | null => {
  const blockObj = asObject(block);
  const id =
    typeof blockObj?.["blockId"] === "string" ? blockObj["blockId"] : "";
  return id ? id : null;
};

export const isBlockFrozen = (block: unknown): boolean => {
  const blockObj = asObject(block);
  return blockObj?.["frozen"] === true;
};

export const resolveCyclesPlanned = (block: unknown): number | null => {
  const blockObj = asObject(block);
  const raw = Number(blockObj?.["cyclesPlanned"]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

export const resolveBaselineTag = (block: unknown): string | null => {
  const blockObj = asObject(block);
  const baseline = asObject(blockObj?.["baseline"]);
  const tag = typeof baseline?.["tag"] === "string" ? baseline["tag"].trim() : "";
  return tag || null;
};
