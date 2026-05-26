import path from "node:path";

import { readJson, writeJson } from "../fs.js";

export type CausalActionType = "command" | "file";

export type CausalLink = {
  id: string;
  createdAt: string;
  action: {
    type: CausalActionType;
    value: string;
  };
  outcome: string;
  confidence: number;
  provenance?: {
    queueId?: string;
    runId?: string;
  };
};

const causalPath = (store: string): string => path.join(store, "memory", "causal.json");

const sortLinks = (entries: CausalLink[]): CausalLink[] =>
  entries.slice().sort((a, b) => {
    const createdDiff = a.createdAt.localeCompare(b.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });

export const readCausalLinks = async (store: string): Promise<CausalLink[]> => {
  return (await readJson<CausalLink[]>(causalPath(store), [])) ?? [];
};

export const writeCausalLinks = async (
  store: string,
  entries: CausalLink[],
): Promise<void> => {
  await writeJson(causalPath(store), sortLinks(entries));
};

export const addCausalLink = async ({
  store,
  action,
  outcome,
  confidence,
  provenance,
}: {
  store: string;
  action: { type: CausalActionType; value: string };
  outcome: string;
  confidence: number;
  provenance?: { queueId?: string; runId?: string };
}): Promise<CausalLink> => {
  const createdAt = new Date().toISOString();
  const entry: CausalLink = {
    id: `causal-${createdAt.replace(/[:.]/g, "-")}`,
    createdAt,
    action: { type: action.type, value: action.value.trim() },
    outcome: outcome.trim(),
    confidence,
    ...(provenance ? { provenance } : {}),
  };
  const links = await readCausalLinks(store);
  links.push(entry);
  await writeCausalLinks(store, links);
  return entry;
};

export const queryCausalLinks = ({
  links,
  command,
  file,
  mode = "or",
}: {
  links: CausalLink[];
  command?: string | null;
  file?: string | null;
  mode?: "and" | "or";
}): CausalLink[] => {
  return links.filter((link) => {
    const matchCommand =
      !command ||
      (link.action.type === "command" && link.action.value.includes(command));
    const matchFile = !file || (link.action.type === "file" && link.action.value === file);
    if (!command && !file) return true;
    if (mode === "and") {
      return matchCommand && matchFile;
    }
    return matchCommand || matchFile;
  });
};
