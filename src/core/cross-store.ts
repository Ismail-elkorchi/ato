import path from "node:path";

import { fileExists, readJson } from "./fs.js";
import type { TargetContext } from "./types.js";

export type CrossStoreAllowEntry = {
  id?: string;
  root?: string;
};

export type CrossStoreConfig = {
  version?: number;
  allowlist?: CrossStoreAllowEntry[];
};

export const crossStoreConfigPath = (storePath: string): string =>
  path.join(storePath, "cross-store.json");

const normalizeRoot = (value: string): string => path.resolve(value);

const matchesAllowEntry = (
  entry: CrossStoreAllowEntry,
  target: TargetContext,
): boolean => {
  if (!entry || typeof entry !== "object") return false;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (id && id === target.id) return true;
  const root = typeof entry.root === "string" ? normalizeRoot(entry.root) : "";
  if (root && root === target.root) return true;
  return false;
};

const configAllows = (config: CrossStoreConfig | null, target: TargetContext): boolean => {
  const allowlist = Array.isArray(config?.allowlist) ? config?.allowlist : [];
  return allowlist.some((entry) => matchesAllowEntry(entry, target));
};

export const loadCrossStoreConfig = async (
  target: TargetContext,
): Promise<{ path: string; config: CrossStoreConfig | null }> => {
  const configPath = crossStoreConfigPath(target.storePath);
  if (!(await fileExists(configPath))) {
    return { path: configPath, config: null };
  }
  const config = await readJson<CrossStoreConfig>(configPath, null);
  return { path: configPath, config };
};

export const crossStoreAllowStatus = async (
  source: TargetContext,
  dest: TargetContext,
): Promise<{
  allowed: boolean;
  sourceAllowed: boolean;
  destAllowed: boolean;
  sourceConfigPath: string;
  destConfigPath: string;
}> => {
  const sourceConfig = await loadCrossStoreConfig(source);
  const destConfig = await loadCrossStoreConfig(dest);
  const sourceAllowed = configAllows(sourceConfig.config, dest);
  const destAllowed = configAllows(destConfig.config, source);
  return {
    allowed: sourceAllowed && destAllowed,
    sourceAllowed,
    destAllowed,
    sourceConfigPath: sourceConfig.path,
    destConfigPath: destConfig.path,
  };
};
