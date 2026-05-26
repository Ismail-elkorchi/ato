import path from "node:path";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import { readJsonl, writeJsonl } from "../fs.js";
import { isIsoDate } from "../queue/transitions.js";
import type { LessonItem } from "../types.js";

const loadLessonSchema = async (): Promise<unknown> => {
  const schemaUrl = new URL("../schemas/lesson.v1.json", import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

const normalizeQueueRefs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(normalized)];
};

export const readLessonItems = async (store: string): Promise<LessonItem[]> => {
  const records = await readJsonl<LessonItem>(
    path.join(store, "lessons", "items.jsonl"),
  );
  return records.map((record) => record.item);
};

export const writeLessonItems = async (
  store: string,
  items: LessonItem[],
): Promise<void> => {
  await writeJsonl(path.join(store, "lessons", "items.jsonl"), items);
};

export const nextLessonId = (lessons: LessonItem[]): string => {
  let max = 0;
  for (const lesson of lessons) {
    const match = String(lesson.id ?? "").match(/^LS-(\d+)$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `LS-${String(max + 1).padStart(4, "0")}`;
};

export const normalizeLessonInput = ({
  input,
  fallbackId,
  now,
}: {
  input: unknown;
  fallbackId: string;
  now?: string;
}): LessonItem => {
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

  const tool = source["tool"] ? String(source["tool"]).trim() : "";
  const rule = source["rule"] ? String(source["rule"]).trim() : "";
  const notes = source["notes"] ? String(source["notes"]).trim() : "";

  return {
    id: source["id"] ? String(source["id"]).trim() : fallbackId,
    ...(tool ? { tool } : {}),
    ...(rule ? { rule } : {}),
    pattern: source["pattern"] ? String(source["pattern"]).trim() : "",
    prevention: source["prevention"]
      ? String(source["prevention"]).trim()
      : "",
    frequency,
    last_seen: timestamp,
    ...(normalizeQueueRefs(source["queue_refs"]).length
      ? { queue_refs: normalizeQueueRefs(source["queue_refs"]) }
      : {}),
    ...(notes ? { notes } : {}),
  };
};

export const validateLessonItem = async (
  lesson: LessonItem,
): Promise<{ ok: boolean; errors: string[] }> => {
  const schema = await loadLessonSchema();
  const ajv = createAjv();
  ajv.addFormat("date-time", isIsoDate);
  const validate = ajv.compile(schema);
  const ok = validate(lesson);
  const errors = [];
  if (!ok) {
    for (const error of validate.errors ?? []) {
      errors.push(`${error.instancePath} ${error.message}`);
    }
  }
  return { ok, errors };
};
