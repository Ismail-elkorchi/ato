import { promises as fs } from "node:fs";

import { resolveSectionFromIndex } from "./index.js";
import type { ContractEntry, ContractIndex } from "./index.js";

export const extractSection = async ({
  index,
  doc,
  section,
  docKey,
}: {
  index: ContractIndex;
  doc: string;
  section: string;
  docKey?: string;
}): Promise<{ entry: ContractEntry; content: string } | null> => {
  const entry = resolveSectionFromIndex({ index, doc: docKey ?? doc, section });
  if (!entry) return null;
  const raw = await fs.readFile(doc, "utf8");
  const lines = raw.split(/\r?\n/);
  const slice = lines.slice(entry.lineStart - 1, entry.lineEnd);
  return {
    entry,
    content: slice.join("\n").trimEnd(),
  };
};

export const extractSections = async ({
  index,
  doc,
  sections,
  docKey,
}: {
  index: ContractIndex;
  doc: string;
  sections: string[];
  docKey?: string;
}): Promise<Array<{ entry: ContractEntry; content: string }>> => {
  const results: Array<{ entry: ContractEntry; content: string }> = [];
  for (const section of sections) {
    const extracted = await extractSection(
      docKey ? { index, doc, section, docKey } : { index, doc, section },
    );
    if (extracted) {
      results.push(extracted);
    }
  }
  return results;
};
