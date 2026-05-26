import { promises as fs } from "node:fs";
import path from "node:path";
import type { AtoConfig } from "../types.js";

export type ContractEntry = {
  id: string;
  heading: string;
  level: number;
  anchor: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  sectionNumber: string | null;
  aliases: string[];
};

export type ContractDoc = {
  doc: string;
  entries: ContractEntry[];
};

export type ContractIndex = {
  version: number;
  generated_at: string;
  docs: ContractDoc[];
  lookup: Record<string, { doc: string; entryId: string }>;
};

const CONTRACT_INDEX_GENERATED_AT = "1970-01-01T00:00:00.000Z";

const normalizeDocKey = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "");

export const toContractDocKey = (root: string, docPath: string): string => {
  const resolved = path.isAbsolute(docPath)
    ? docPath
    : path.resolve(root, docPath);
  const rel = path.relative(root, resolved) || docPath;
  return normalizeDocKey(rel);
};

const slugify = (value: unknown): string =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const extractSectionNumber = (title: string): string | null => {
  const match = title.match(/^(\d+(?:\.\d+)*)(?:\)|\s|$)/);
  return match?.[1] ?? null;
};

const extractLetterPrefix = (title: string): string | null => {
  const match = title.match(/^([A-Z])\)/);
  return match?.[1] ?? null;
};

const collectEntries = (lines: string[]): ContractEntry[] => {
  const stack: ContractEntry[] = [];
  const entries: ContractEntry[] = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (!match) return;

    const level = (match[1] ?? "").length;
    const heading = (match[2] ?? "").trim();
    while (stack.length) {
      const last = stack[stack.length - 1];
      if (!last || last.level < level) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1] ?? null;
    const sectionNumber = extractSectionNumber(heading);
    const letter = extractLetterPrefix(heading);

    const pathParts = [...stack.map((entry) => entry.heading), heading];
    const pathLabel = pathParts.join(" / ");
    const anchor = slugify(heading) || `section-${index + 1}`;
    const id = `${anchor}-${index + 1}`;

    const aliases = [];
    if (sectionNumber) {
      aliases.push(sectionNumber, `§${sectionNumber}`);
    }
    if (letter && parent?.sectionNumber) {
      const composite = `${parent.sectionNumber}.${letter}`;
      aliases.push(composite, `§${composite}`);
    }

    const entry: ContractEntry = {
      id,
      heading,
      level,
      anchor,
      path: pathLabel,
      lineStart: index + 1,
      lineEnd: lines.length,
      sectionNumber: sectionNumber ?? parent?.sectionNumber ?? null,
      aliases,
    };

    entries.push(entry);
    stack.push(entry);
  });

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const next = entries
      .slice(i + 1)
      .find((other) => other.level <= entry.level);
    if (next) {
      entry.lineEnd = next.lineStart - 1;
    }
  }

  return entries;
};

export const buildContractIndex = async (
  docs: Array<{ path: string; absPath: string }>,
): Promise<ContractIndex> => {
  const docEntries: ContractDoc[] = [];
  const lookup: Record<string, { doc: string; entryId: string }> = {};

  for (const doc of docs) {
    const docKey = normalizeDocKey(doc.path);
    const raw = await fs.readFile(doc.absPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const entries = collectEntries(lines);

    for (const entry of entries) {
      const aliases = new Set(entry.aliases);
      aliases.add(entry.heading);
      aliases.add(entry.path);
      aliases.add(entry.anchor);
      for (const alias of aliases) {
        const key = `${docKey}::${alias}`;
        lookup[key] = {
          doc: docKey,
          entryId: entry.id,
        };
      }
    }

    docEntries.push({
      doc: docKey,
      entries,
    });
  }

  return {
    version: 1,
    generated_at: CONTRACT_INDEX_GENERATED_AT,
    docs: docEntries,
    lookup,
  };
};

export const resolveSectionFromIndex = ({
  index,
  doc,
  section,
}: {
  index: ContractIndex;
  doc: string;
  section: string;
}): ContractEntry | null => {
  const docKey = normalizeDocKey(doc);
  const key = `${docKey}::${section}`;
  const match = index.lookup?.[key];
  if (!match) return null;
  const docEntry = index.docs?.find((entry) => entry.doc === docKey);
  if (!docEntry) return null;
  return docEntry.entries.find((entry) => entry.id === match.entryId) ?? null;
};

export const resolveAliasMatches = ({
  index,
  alias,
  doc,
}: {
  index: ContractIndex;
  alias: string;
  doc?: string | null;
}): Array<{ doc: string; entry: ContractEntry }> => {
  const matches: Array<{ doc: string; entry: ContractEntry }> = [];
  const docKey = doc ? normalizeDocKey(doc) : null;
  for (const docEntry of index.docs ?? []) {
    if (docKey && docEntry.doc !== docKey) continue;
    for (const entry of docEntry.entries ?? []) {
      if (entry.id === alias || entry.anchor === alias) {
        matches.push({ doc: docEntry.doc, entry });
      }
    }
  }
  return matches;
};

export const listDocEntries = (index: ContractIndex) => {
  const records: Array<{
    doc: string;
    id: string;
    heading: string;
    path: string;
    anchor: string;
    sectionNumber: string | null;
    aliases: string[];
  }> = [];
  for (const doc of index.docs ?? []) {
    for (const entry of doc.entries ?? []) {
      records.push({
        doc: doc.doc,
        id: entry.id,
        heading: entry.heading,
        path: entry.path,
        anchor: entry.anchor,
        sectionNumber: entry.sectionNumber,
        aliases: entry.aliases,
      });
    }
  }
  return records;
};

export const resolveDocPath = (
  config: AtoConfig,
  docId: string | null,
): string | null => {
  if (docId) return docId;
  const contracts = config?.contracts;
  if (!contracts) return null;
  if (typeof contracts === "string") return contracts;
  if (Array.isArray(contracts)) return contracts[0] ?? null;
  return contracts.platform ?? null;
};

export const normalizeContractDocs = (config: AtoConfig) => {
  if (!config?.contracts) return [];
  if (Array.isArray(config.contracts)) {
    return config.contracts.map((doc) => ({ path: doc }));
  }
  if (typeof config.contracts === "string") {
    return [{ path: config.contracts }];
  }
  if (typeof config.contracts === "object") {
    const docs = [];
    if (config.contracts.platform) {
      docs.push({ path: config.contracts.platform });
    }
    if (Array.isArray(config.contracts.extra)) {
      for (const doc of config.contracts.extra) {
        docs.push({ path: doc });
      }
    }
    return docs;
  }
  return [];
};

export const resolveContractDocs = (
  config: AtoConfig,
  root: string,
): Array<{ path: string; absPath: string }> => {
  const docs = normalizeContractDocs(config);
  return docs.map((doc) => {
    const absPath = path.resolve(root, doc.path);
    return {
      path: toContractDocKey(root, doc.path),
      absPath,
    };
  });
};
