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
  listTests,
  impactCachePath,
} from "../../core/impact/index.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato test select [options]",
  "",
  "Options:",
  "  --paths <a,b,c>   Comma-delimited changed file paths",
  "  --full            Select the full test suite",
  "  --explain         Include graph edges that led to each test",
  "  --refresh         Rebuild the impact graph before selection",
  "",
  "Examples:",
  "  ato test select --paths src/cli/main.ts",
  "  ato test select --full",
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

export const runTestCommand = async ({
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

  if (subcommand !== "select") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown test subcommand." } });
    } else {
      writeLines(["Unknown test subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

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

    const rawPaths = typeof flags["paths"] === "string" ? flags["paths"] : null;
    const changed = rawPaths
      ? rawPaths
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : await readChangedFiles(target.root);
    const normalized = changed.map((entry) => normalizePath(target.root, entry));

    const full = Boolean(flags["full"]);
    const explain = Boolean(flags["explain"]);

    const impact = queryImpact({ graph, changed: normalized });
    const selectedTests = full
      ? listTests(graph)
      : impact.impactedTests.map((entry) => entry.path);

    const edgeMap = new Map<string, { from: string; to: string; reason: string }>();
    for (const edge of graph.edges) {
      edgeMap.set(`${edge.from}::${edge.to}`, edge);
    }

    const reverse = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
      reverse.get(edge.to)?.add(edge.from);
    }

    const parent = new Map<string, string>();
    const queue = [...impact.changed];
    const visited = new Set(queue);
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      const dependents = reverse.get(current) ?? new Set();
      for (const dependent of dependents) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        parent.set(dependent, current);
        queue.push(dependent);
      }
    }

    const rankByPath = new Map(
      impact.impactedFiles.map((entry) => [entry.path, entry.rank]),
    );

    const explainEdges = (testPath: string) => {
      const edges = [];
      let current = testPath;
      while (parent.has(current)) {
        const prev = parent.get(current);
        if (!prev) break;
        const edge = edgeMap.get(`${prev}::${current}`);
        edges.push(edge ?? { from: prev, to: current, reason: "import" });
        current = prev;
      }
      return edges.reverse();
    };

    if (json) {
      writeJson({
        ok: true,
        mode: full ? "full" : "targeted",
        changed: impact.changed,
        missing: impact.missing,
        tests: selectedTests.map((entry) => ({
          path: entry,
          rank: rankByPath.get(entry) ?? null,
          edges: explain ? explainEdges(entry) : undefined,
        })),
        graph: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          cache: impactCachePath(target.storePath),
        },
      });
    } else {
      const lines = [
        formatTargetLine(target),
        `mode: ${full ? "full" : "targeted"}`,
        `tests: ${selectedTests.length}`,
        "",
      ];
      for (const entry of selectedTests) {
        const rank = rankByPath.get(entry);
        lines.push(`- ${entry}${rank !== undefined ? ` (rank ${rank})` : ""}`);
        if (explain) {
          const edges = explainEdges(entry);
          for (const edge of edges) {
            lines.push(`  ${edge.from} -> ${edge.to}`);
          }
        }
      }
      if (!selectedTests.length) {
        lines.push("No tests selected.");
      }
      writeLines(lines);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
