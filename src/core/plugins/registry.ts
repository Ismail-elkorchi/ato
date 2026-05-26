import path from "node:path";

import { readJson, writeJson, fileExists } from "../fs.js";
import type { JsonValue } from "../types.js";

export type PluginCapabilities = {
  network?: boolean;
  fs?: "none" | "plugin" | "target";
};

export type PluginEntry = {
  name: string;
  version: string;
  entry: string;
  root: string;
  hooks: string[];
  priority: number;
  capabilities?: PluginCapabilities;
};

export type PluginRegistry = {
  version: number;
  plugins: PluginEntry[];
};

export const registryPath = (storePath: string): string =>
  path.join(storePath, "plugins", "plugins.json");

const normalizeHook = (hook: string): string => hook.trim();

export const normalizePluginEntry = (entry: PluginEntry): PluginEntry => ({
  ...entry,
  hooks: entry.hooks.map(normalizeHook).filter(Boolean),
  priority: Number.isFinite(entry.priority) ? entry.priority : 0,
});

export const sortPlugins = (entries: PluginEntry[]): PluginEntry[] =>
  [...entries].sort((a, b) => {
    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return a.name.localeCompare(b.name);
  });

export const readPluginRegistry = async (
  storePath: string,
): Promise<PluginRegistry> => {
  const pathToRegistry = registryPath(storePath);
  const raw = await readJson<PluginRegistry>(pathToRegistry, null);
  if (!raw) {
    return { version: 1, plugins: [] };
  }
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  return { version: raw.version ?? 1, plugins: sortPlugins(plugins) };
};

export const writePluginRegistry = async (
  storePath: string,
  registry: PluginRegistry,
): Promise<void> => {
  const payload: PluginRegistry = {
    version: registry.version ?? 1,
    plugins: sortPlugins(registry.plugins),
  };
  await writeJson(registryPath(storePath), payload as JsonValue);
};

export const pluginEntryExists = async (entryPath: string): Promise<boolean> =>
  fileExists(entryPath);
