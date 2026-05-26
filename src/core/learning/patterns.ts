import path from "node:path";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import { readJsonl, writeJsonl } from "../fs.js";
import { isIsoDate } from "../queue/transitions.js";
import type { PatternItem } from "../types.js";

const loadPatternSchema = async (): Promise<unknown> => {
  const schemaUrl = new URL("../schemas/pattern.v1.json", import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

const normalizeQueueRefs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(normalized)];
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(normalized)];
};

export const readPatternItems = async (
  store: string,
): Promise<PatternItem[]> => {
  const records = await readJsonl<PatternItem>(
    path.join(store, "patterns", "items.jsonl"),
  );
  return records.map((record) => record.item);
};

export const writePatternItems = async (
  store: string,
  items: PatternItem[],
): Promise<void> => {
  await writeJsonl(path.join(store, "patterns", "items.jsonl"), items);
};

export const applyPatternItem = async ({
  store,
  id,
  queueId,
  now,
}: {
  store: string;
  id: string;
  queueId?: string;
  now?: string;
}): Promise<PatternItem | null> => {
  const patterns = await readPatternItems(store);
  const pattern = patterns.find((entry) => entry.id === id) ?? null;
  if (!pattern) return null;
  pattern.frequency = Number(pattern.frequency ?? 0) + 1;
  pattern.last_seen = now ?? new Date().toISOString();
  if (queueId) {
    const refs = Array.isArray(pattern.queue_refs) ? pattern.queue_refs : [];
    if (!refs.includes(queueId)) {
      refs.push(queueId);
      pattern.queue_refs = refs;
    }
  }
  await writePatternItems(store, patterns);
  return pattern;
};

export const nextPatternId = (patterns: PatternItem[]): string => {
  let max = 0;
  for (const pattern of patterns) {
    const match = String(pattern.id ?? "").match(/^PT-(\d+)$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `PT-${String(max + 1).padStart(4, "0")}`;
};

export const normalizePatternInput = ({
  input,
  fallbackId,
  now,
}: {
  input: unknown;
  fallbackId: string;
  now?: string;
}): PatternItem => {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const timestamp = isIsoDate(source["last_seen"])
    ? source["last_seen"]
    : (now ?? new Date().toISOString());
  const frequencyValue = Number(source["frequency"]);
  const frequency =
    Number.isInteger(frequencyValue) && frequencyValue > 0 ? frequencyValue : 1;

  const summary = source["summary"] ? String(source["summary"]).trim() : "";

  return {
    id: source["id"] ? String(source["id"]).trim() : fallbackId,
    title: source["title"] ? String(source["title"]).trim() : "",
    kind: source["kind"] ? String(source["kind"]).trim() : "",
    ...(summary ? { summary } : {}),
    ...(normalizeStringArray(source["steps"]).length
      ? { steps: normalizeStringArray(source["steps"]) }
      : {}),
    ...(normalizeStringArray(source["signals"]).length
      ? { signals: normalizeStringArray(source["signals"]) }
      : {}),
    ...(normalizeQueueRefs(source["queue_refs"]).length
      ? { queue_refs: normalizeQueueRefs(source["queue_refs"]) }
      : {}),
    frequency,
    last_seen: timestamp,
  };
};

export const validatePatternItem = async (
  pattern: PatternItem,
): Promise<{ ok: boolean; errors: string[] }> => {
  const schema = await loadPatternSchema();
  const ajv = createAjv();
  ajv.addFormat("date-time", isIsoDate);
  const validate = ajv.compile(schema);
  const ok = validate(pattern);
  const errors = [];
  if (!ok) {
    for (const error of validate.errors ?? []) {
      errors.push(`${error.instancePath} ${error.message}`);
    }
  }
  return { ok, errors };
};
