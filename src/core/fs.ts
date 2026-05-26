import { promises as fs } from "node:fs";
import path from "node:path";

import type { JsonValue, JsonlRecord } from "./types.js";

export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const readJson = async <T = JsonValue>(
  filePath: string,
  fallback: T | null = null,
): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
};

const normalizeValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return entries.reduce<Record<string, JsonValue>>((acc, [key, val]) => {
      acc[key] = normalizeValue(val);
      return acc;
    }, {});
  }
  return value;
};

export const writeJson = async (
  filePath: string,
  data: JsonValue,
): Promise<void> => {
  const normalized = normalizeValue(data);
  const output = `${JSON.stringify(normalized, null, 2)}\n`;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, output, "utf8");
};

export const readJsonl = async <T = JsonValue>(
  filePath: string,
): Promise<JsonlRecord<T>[]> => {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => ({
    line: index + 1,
    raw: line,
    item: JSON.parse(line) as T,
  }));
};

export const writeJsonl = async <T = JsonValue>(
  filePath: string,
  items: T[],
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

export const appendJsonl = async <T = JsonValue>(
  filePath: string,
  item: T,
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(item)}\n`;
  await fs.appendFile(filePath, line, "utf8");
};

export const listDirRecursive = async (
  basePath: string,
  rel: string = "",
): Promise<string[]> => {
  const entries = await fs.readdir(path.join(basePath, rel), {
    withFileTypes: true,
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const results = [];
  for (const entry of entries) {
    const nextRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listDirRecursive(basePath, nextRel)));
    } else if (entry.isFile()) {
      results.push(nextRel);
    }
  }
  return results;
};

export const stableStringify = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => {
        return `${JSON.stringify(key)}:${stableStringify(entryValue)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
