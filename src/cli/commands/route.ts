import path from "node:path";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { writeJson as writeJsonFile } from "../../core/fs.js";
import type { CommandContext } from "../types.js";

const HELP_TOKENS = new Set(["--help", "-h", "help"]);
const ROUTE_USAGE = "Usage: ato route index|pack [options]";

type RouteIndex = {
  version: number;
  generated_at: string;
  root: string;
  routers?: Array<{ path: string; scope?: string | null; dir?: string }>;
};

const indexPathFor = (store: string): string =>
  path.join(store, "cache", "routes.index.json");

const listAgentsFiles = async (root: string): Promise<string[]> => {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name.startsWith(".git") ||
        entry.name === ".ato"
      ) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "AGENTS.md") {
        results.push(full);
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
};

const parseScope = (content: string): string | null => {
  const match = content.match(/^Scope:\s*(.+)$/m);
  if (!match) return null;
  const raw = (match[1] ?? "").trim();
  if (!raw) return null;
  const unwrapped = raw.replace(/^`|`$/g, "");
  return unwrapped;
};

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
};

export const runRouteCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);
  const subcommandValue = subcommand ?? "";
  const helpRequested =
    Boolean(flags["help"]) || HELP_TOKENS.has(subcommandValue.toLowerCase());
  if (helpRequested) {
    if (subcommand === "index") {
      writeLines(["Usage: ato route index [options]"]);
      return;
    }
    if (subcommand === "pack") {
      writeLines(["Usage: ato route pack --path <file> [options]"]);
      return;
    }
    writeLines([ROUTE_USAGE]);
    return;
  }

  if (subcommand === "index") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const files = await listAgentsFiles(target.root);
      const routers: Array<{ path: string; scope: string | null; dir: string }> =
        [];
      for (const file of files) {
        const content = await fs.readFile(file, "utf8");
        routers.push({
          path: path.relative(target.root, file),
          scope: parseScope(content),
          dir: path.relative(target.root, path.dirname(file)) || ".",
        });
      }
      const payload = {
        version: 1,
        generated_at: new Date().toISOString(),
        root: target.root,
        routers,
      };
      const outPath = indexPathFor(target.storePath);
      await writeJsonFile(outPath, payload);

      if (json) {
        writeJson({ ok: true, path: outPath, count: routers.length });
      } else {
        writeLines([
          `target: ${target.id} root: ${target.root}`,
          `routes: ${routers.length}`,
          `index: ${outPath}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "pack") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    if (typeof flags["path"] !== "string") {
      throw new Error("Missing required --path.");
    }
    const indexPath = indexPathFor(target.storePath);
    const index = await fs
      .readFile(indexPath, "utf8")
      .then((raw) => JSON.parse(raw) as RouteIndex)
      .catch(() => null);
    if (!index) {
      throw new Error("Missing route index. Run `ato route index` first.");
    }

    const filePath = path.resolve(target.root, flags["path"]);
    const relPath = path.relative(target.root, filePath).replace(/\\/g, "/");

    const routers = index.routers ?? [];
    const rootRouter =
      routers.find((router) => router.path === "AGENTS.md") ?? null;
    const scoped = routers.filter(
      (router) => router.scope && router.path !== "AGENTS.md",
    );

    let match = null;
    for (const router of scoped) {
      const scope = router.scope ?? "";
      const pattern = globToRegExp(scope);
      if (pattern.test(relPath)) {
        if (!match || scope.length > (match.scope ?? "").length) {
          match = router;
        }
      }
    }

    const resolved = [];
    if (rootRouter) resolved.push(rootRouter);
    if (match) resolved.push(match);

    const outputs = [];
    for (const router of resolved) {
      const content = await fs.readFile(
        path.join(target.root, router.path),
        "utf8",
      );
      outputs.push({
        path: router.path,
        scope: router.scope,
        content,
      });
    }

    if (json) {
      writeJson({ ok: true, file: relPath, routers: outputs });
    } else {
      const lines = [];
      for (const router of outputs) {
        lines.push(`# ${router.path}`);
        lines.push(router.content.trim());
        lines.push("");
      }
      writeLines(lines);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown route subcommand." },
    });
    } else {
      writeLines([
        "Unknown route subcommand.",
        ROUTE_USAGE,
      ]);
    }
  process.exitCode = 1;
};
