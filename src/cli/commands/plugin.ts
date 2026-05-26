import path from "node:path";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import { parseJsonInput } from "./input.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  readPluginRegistry,
  writePluginRegistry,
  pluginEntryExists,
  type PluginCapabilities,
  type PluginEntry,
} from "../../core/plugins/registry.js";
import type { CommandContext } from "../types.js";

type PlainObject = Record<string, unknown>;

const HELP = [
  "Usage: ato plugin add --input <json|path>",
  "",
  "Hooks:",
  "  gate.pre, gate.post, queue.pre, queue.post, cycle.post",
  "",
  "Example:",
  "  ato plugin add --input '{\"name\":\"my-plugin\",\"version\":\"1.0.0\",\"entry\":\"plugins/my-plugin/index.js\",\"hooks\":[\"cycle.post\"]}'",
].join("\n");

const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeHooks = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeCapabilities = (value: unknown): PluginCapabilities | undefined => {
  if (!isPlainObject(value)) return undefined;
  const network = Boolean(value["network"]);
  const fsScope = value["fs"];
  return {
    network,
    fs: fsScope === "none" || fsScope === "target" ? fsScope : "plugin",
  };
};

const cmdAdd = async ({
  context,
  flags,
}: {
  context: CommandContext;
  flags: Record<string, string | boolean>;
}): Promise<void> => {
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const parsed = await parseJsonInput(flags["input"]);
    if (!parsed.ok) throw new Error(parsed.error);
    if (!isPlainObject(parsed.value)) {
      throw new Error("--input must be a JSON object.");
    }
    const name = String(parsed.value["name"] ?? "").trim();
    const version = String(parsed.value["version"] ?? "").trim();
    const entryValue = String(parsed.value["entry"] ?? "").trim();
    const hooks = normalizeHooks(parsed.value["hooks"]);
    const priority = Number(parsed.value["priority"] ?? 0);
    const capabilities = normalizeCapabilities(parsed.value["capabilities"]);

    if (!name) throw new Error("Plugin name is required.");
    if (!version) throw new Error("Plugin version is required.");
    if (!entryValue) throw new Error("Plugin entry is required.");
    if (!hooks.length) throw new Error("Plugin hooks are required.");

    const entryPath = path.resolve(target.root, entryValue);
    const relativeEntry = path.relative(target.root, entryPath);
    if (relativeEntry.startsWith("..")) {
      throw new Error("Plugin entry must be within the target root.");
    }
    if (!(await pluginEntryExists(entryPath))) {
      throw new Error(`Plugin entry not found: ${relativeEntry}`);
    }

    const plugin: PluginEntry = {
      name,
      version,
      entry: relativeEntry,
      root: path.dirname(relativeEntry),
      hooks,
      priority: Number.isFinite(priority) ? priority : 0,
      ...(capabilities ? { capabilities } : {}),
    };

    const registry = await readPluginRegistry(target.storePath);
    const updated = registry.plugins.filter((item) => item.name !== name);
    updated.push(plugin);
    await writePluginRegistry(target.storePath, {
      version: registry.version ?? 1,
      plugins: updated,
    });

    if (context.json) {
      writeJson({ ok: true, plugin });
    } else {
      writeLines([
        `plugin added: ${name}@${version}`,
        `entry: ${relativeEntry}`,
        `hooks: ${plugin.hooks.join(", ")}`,
      ]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};

export const runPluginCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { flags } = parseFlags(args);

  if (!subcommand) {
    writeLines([HELP]);
    return;
  }

  if (subcommand === "add") {
    await cmdAdd({ context, flags });
    return;
  }

  if (context.json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown plugin subcommand." },
    });
  } else {
    writeLines(["Unknown plugin subcommand.", HELP]);
  }
  process.exitCode = 1;
};
