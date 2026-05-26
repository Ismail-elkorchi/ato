import { spawn } from "node:child_process";
import path from "node:path";

import {
  readPluginRegistry,
  sortPlugins,
  type PluginEntry,
} from "./registry.js";
import type { TargetContext } from "../types.js";

export type PluginHookContext = {
  hook: string;
  action: string;
  cycleId?: string | null;
  blockId?: string | null;
  queueId?: string | null;
  mode?: string | null;
  status?: { from?: string | null; to?: string | null };
  target: { id: string; root: string };
  metadata?: Record<string, unknown>;
};

type PluginRunResult = {
  name: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const runPlugin = async ({
  plugin,
  hook,
  payload,
  target,
}: {
  plugin: PluginEntry;
  hook: string;
  payload: PluginHookContext;
  target: TargetContext;
}): Promise<PluginRunResult> => {
  const entryPath = path.resolve(target.root, plugin.entry);
  const rootPath = path.resolve(target.root, plugin.root);
  return new Promise((resolve) => {
    const child = spawn("node", [entryPath], {
      cwd: rootPath,
      env: {
        ...process.env,
        ATO_PLUGIN_HOOK: hook,
        ATO_PLUGIN_NAME: plugin.name,
        ATO_PLUGIN_VERSION: plugin.version,
        ATO_PLUGIN_ROOT: rootPath,
        ATO_REPO_ROOT: target.root,
        ATO_REPO_ID: target.id,
        ATO_PLUGIN_ALLOW_NETWORK: plugin.capabilities?.network ? "1" : "0",
        ATO_PLUGIN_FS_SCOPE: plugin.capabilities?.fs ?? "plugin",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
    child.on("close", (code) => {
      resolve({
        name: plugin.name,
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
};

export const runPluginHooks = async ({
  target,
  hook,
  payload,
  enabled,
}: {
  target: TargetContext;
  hook: string;
  payload: PluginHookContext;
  enabled: boolean;
}): Promise<PluginRunResult[]> => {
  if (!enabled) return [];
  const registry = await readPluginRegistry(target.storePath);
  const matches = registry.plugins.filter((plugin) =>
    plugin.hooks.includes(hook),
  );
  const ordered = sortPlugins(matches);
  const results: PluginRunResult[] = [];
  for (const plugin of ordered) {
    const result = await runPlugin({ plugin, hook, payload, target });
    results.push(result);
    if (!result.ok) {
      const error = new Error(
        `Plugin '${plugin.name}' failed for hook '${hook}'.`,
      );
      (error as Error & { details?: unknown }).details = {
        hook,
        plugin: plugin.name,
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
      throw error;
    }
  }
  return results;
};
