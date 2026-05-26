import path from "node:path";

import { readJson, writeJson } from "../fs.js";

export type CommitmentStatus = "open" | "resolved";

export type CommitmentEntry = {
  id: string;
  scope: string;
  owner: string;
  summary: string;
  status: CommitmentStatus;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
};

const commitmentsPath = (store: string): string =>
  path.join(store, "memory", "commitments.json");

const sortCommitments = (entries: CommitmentEntry[]): CommitmentEntry[] =>
  entries.slice().sort((a, b) => {
    const createdDiff = a.createdAt.localeCompare(b.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });

export const readCommitments = async (
  store: string,
): Promise<CommitmentEntry[]> => {
  return (await readJson<CommitmentEntry[]>(commitmentsPath(store), [])) ?? [];
};

export const writeCommitments = async (
  store: string,
  entries: CommitmentEntry[],
): Promise<void> => {
  await writeJson(commitmentsPath(store), sortCommitments(entries));
};

export const addCommitment = async ({
  store,
  scope,
  owner,
  summary,
}: {
  store: string;
  scope: string;
  owner: string;
  summary: string;
}): Promise<CommitmentEntry> => {
  const createdAt = new Date().toISOString();
  const entry: CommitmentEntry = {
    id: `commitment-${createdAt.replace(/[:.]/g, "-")}`,
    scope: scope.trim(),
    owner: owner.trim(),
    summary: summary.trim(),
    status: "open",
    createdAt,
  };
  const entries = await readCommitments(store);
  entries.push(entry);
  await writeCommitments(store, entries);
  return entry;
};

export const resolveCommitment = async ({
  store,
  id,
}: {
  store: string;
  id: string;
}): Promise<CommitmentEntry | null> => {
  const entries = await readCommitments(store);
  const target = entries.find((entry) => entry.id === id) ?? null;
  if (!target) return null;
  if (target.status === "resolved") return target;
  const now = new Date().toISOString();
  target.status = "resolved";
  target.updatedAt = now;
  target.resolvedAt = now;
  await writeCommitments(store, entries);
  return target;
};
