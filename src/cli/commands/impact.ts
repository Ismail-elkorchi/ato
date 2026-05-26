import path from "node:path";
import { spawn } from "node:child_process";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  buildImpactGraph,
  readImpactGraph,
  writeImpactGraph,
  queryImpact,
  impactCachePath,
} from "../../core/impact/index.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato impact build|query [options]",
  "",
  "Subcommands:",
  "  build                 Build and cache the impact graph",
  "  query                 Query impact for changed files",
  "",
  "Options (query):",
  "  --paths <a,b,c>       Comma-delimited changed file paths",
  "  --refresh             Rebuild the graph before query",
  "",
  "Examples:",
  "  ato impact build",
  "  ato impact query --paths src/cli/main.ts",
].join("\n");

const readChangedFiles = async (root: string): Promise<string[]> =>
  new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: root });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const files: string[] = [];
      for (const line of lines) {
        const raw = line.slice(3).trim();
        if (!raw) continue;
        if (raw.includes(" -> ")) {
          const renamed = raw.split(" -> ").pop();
          if (renamed) files.push(renamed.trim());
        } else {
          files.push(raw);
        }
      }
      files.sort((a, b) => a.localeCompare(b));
      resolve(files);
    });
  });

const normalizePath = (root: string, input: string): string => {
  const resolved = path.resolve(root, input);
  const rel = path.relative(root, resolved);
  return rel.replace(/\\/g, "/");
};

export const runImpactCommand = async ({
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

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand === "build") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const graph = await buildImpactGraph({ root: target.root });
      await writeImpactGraph(target.storePath, graph);
      if (json) {
        writeJson({
          ok: true,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          cache: impactCachePath(target.storePath),
        });
      } else {
        writeLines([
          formatTargetLine(target),
          `nodes: ${graph.nodes.length}`,
          `edges: ${graph.edges.length}`,
          `cache: ${impactCachePath(target.storePath)}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "query") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const refresh = Boolean(flags["refresh"]);
      let graph = !refresh ? await readImpactGraph(target.storePath) : null;
      if (!graph) {
        graph = await buildImpactGraph({ root: target.root });
        await writeImpactGraph(target.storePath, graph);
      }

      const rawPaths =
        typeof flags["paths"] === "string"
          ? flags["paths"]
          : typeof flags["path"] === "string"
            ? flags["path"]
            : null;
      const changed = rawPaths
        ? rawPaths
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : await readChangedFiles(target.root);
      const normalized = changed.map((entry) => normalizePath(target.root, entry));

      const impact = queryImpact({
        graph,
        changed: normalized,
      });

      if (json) {
        writeJson({
          ok: true,
          changed: impact.changed,
          missing: impact.missing,
          graph,
          impact: {
            files: impact.impactedFiles,
            packages: impact.impactedPackages,
            tests: impact.impactedTests,
            edges: impact.impactEdges,
          },
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `changed: ${impact.changed.length}`,
          `packages: ${impact.impactedPackages.length}`,
          `tests: ${impact.impactedTests.length}`,
          "",
          "Impacted packages:",
          impact.impactedPackages.length
            ? impact.impactedPackages
                .map((entry) => `- ${entry.name} (rank ${entry.rank})`)
                .join("\n")
            : "- none",
          "",
          "Impacted tests:",
          impact.impactedTests.length
            ? impact.impactedTests
                .map((entry) => `- ${entry.path} (rank ${entry.rank})`)
                .join("\n")
            : "- none",
        ];
        if (impact.missing.length) {
          lines.push("");
          lines.push("Missing files:");
          lines.push(impact.missing.map((entry) => `- ${entry}`).join("\n"));
        }
        writeLines(lines);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (json) {
    writeJson({ ok: false, code: 1, error: { message: "Unknown impact subcommand." } });
  } else {
    writeLines(["Unknown impact subcommand.", HELP]);
  }
  process.exitCode = 1;
};
