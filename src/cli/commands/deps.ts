import path from "node:path";
import { spawn } from "node:child_process";

import {
  parseFlags,
  writeJson as writeJsonOutput,
  writeLines,
  formatTargetLine,
} from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { writeJson as writeJsonFile } from "../../core/fs.js";
import {
  buildDepsGraph,
  readDepsGraph,
  writeDepsGraph,
  depsCachePath,
  resolveDepsImpact,
  detectDepsCycles,
} from "../../core/deps/index.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato deps build|query [options]",
  "",
  "Subcommands:",
  "  build                 Build and cache the dependency graph",
  "  query                 Query dependency impact for changed files",
  "  lint                  Detect dependency cycles and emit a report",
  "",
  "Options (query):",
  "  --paths <a,b,c>       Comma-delimited changed file paths",
  "  --refresh             Rebuild the graph before query",
  "",
  "Options (lint):",
  "  --refresh             Rebuild the graph before lint",
  "",
  "Examples:",
  "  ato deps build",
  "  ato deps query --paths src/cli/main.ts",
  "  ato deps lint --refresh",
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

const toRelativeArtifactPath = (root: string, input: string): string => {
  const rel = normalizePath(root, input);
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../")) {
    return "<redacted>";
  }
  return rel;
};

export const runDepsCommand = async ({
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
      const graph = await buildDepsGraph({ root: target.root });
      await writeDepsGraph(target.storePath, graph);
      if (json) {
        writeJsonOutput({
          ok: true,
          packages: graph.packages.length,
          edges: graph.edges.length,
          cache: depsCachePath(target.storePath),
        });
      } else {
        writeLines([
          formatTargetLine(target),
          `packages: ${graph.packages.length}`,
          `edges: ${graph.edges.length}`,
          `cache: ${depsCachePath(target.storePath)}`,
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
      let graph = !refresh ? await readDepsGraph(target.storePath) : null;
      if (!graph) {
        graph = await buildDepsGraph({ root: target.root });
        await writeDepsGraph(target.storePath, graph);
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
      const normalized = changed
        .map((entry) => normalizePath(target.root, entry))
        .sort((a, b) => a.localeCompare(b));

      const impact = resolveDepsImpact({ graph, changedPaths: normalized });

      if (json) {
        writeJsonOutput({
          ok: true,
          changed: impact.changedPaths,
          missing: impact.missingPaths,
          graph,
          impact: {
            packages: impact.impactedPackages,
            bumpCandidates: impact.bumpCandidates,
            edges: impact.edges,
          },
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `changed packages: ${impact.changedPackages.length}`,
          `impacted packages: ${impact.impactedPackages.length}`,
          `bump candidates: ${impact.bumpCandidates.length}`,
          "",
          "Impacted packages:",
          impact.impactedPackages.length
            ? impact.impactedPackages
                .map(
                  (entry) =>
                    `- ${entry.name} (rank ${entry.rank}, ${entry.reason.type}${
                      entry.reason.via ? ` via ${entry.reason.via}` : ""
                    })`,
                )
                .join("\n")
            : "- none",
          "",
          "Version bump candidates:",
          impact.bumpCandidates.length
            ? impact.bumpCandidates
                .map(
                  (entry) =>
                    `- ${entry.name} (rank ${entry.rank}, ${entry.reason.type}${
                      entry.reason.via ? ` via ${entry.reason.via}` : ""
                    })`,
                )
                .join("\n")
            : "- none",
        ];
        if (impact.missingPaths.length) {
          lines.push("");
          lines.push("Missing paths:");
          lines.push(impact.missingPaths.map((entry) => `- ${entry}`).join("\n"));
        }
        writeLines(lines);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "lint") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const refresh = Boolean(flags["refresh"]);
      let graph = !refresh ? await readDepsGraph(target.storePath) : null;
      if (!graph) {
        graph = await buildDepsGraph({ root: target.root });
        await writeDepsGraph(target.storePath, graph);
      }

      const cycles = detectDepsCycles(graph);
      const generatedAt = new Date().toISOString();
      const artifactsDir = getArtifactsDir(target.storePath, null, "deps");
      const fileName = `deps-lint-${generatedAt.replace(/[:.]/g, "-")}.json`;
      const artifactPath = path.join(artifactsDir, fileName);
      const artifactRel = toRelativeArtifactPath(target.root, artifactPath);
      const report = {
        ok: cycles.length === 0,
        generatedAt,
        packages: graph.packages.length,
        edges: graph.edges.length,
        cycles,
      };
      await writeJsonFile(artifactPath, report);

      await appendRunLog(target.storePath, {
        ts: generatedAt,
        kind: "lint",
        target_id: target.id,
        commands: [],
        artifacts: [artifactRel],
        summary: "deps lint",
      });

      if (json) {
        writeJsonOutput({
          ok: report.ok,
          packages: report.packages,
          edges: report.edges,
          cycles: report.cycles,
          artifact: artifactRel,
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `packages: ${report.packages}`,
          `edges: ${report.edges}`,
          `cycles: ${report.cycles.length}`,
          `artifact: ${artifactRel}`,
        ];
        if (report.cycles.length) {
          lines.push("");
          lines.push("Cycles:");
          lines.push(
            report.cycles
              .map((cycle) => `- ${cycle.path.join(" -> ")}`)
              .join("\n"),
          );
        }
        writeLines(lines);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (json) {
    writeJsonOutput({
      ok: false,
      code: 1,
      error: { message: "Unknown deps subcommand." },
    });
  } else {
    writeLines(["Unknown deps subcommand.", HELP]);
  }
  process.exitCode = 1;
};
