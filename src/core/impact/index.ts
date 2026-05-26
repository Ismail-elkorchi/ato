import path from "node:path";
import { promises as fs } from "node:fs";

import { readJson, writeJson } from "../fs.js";

type ImpactEdge = {
  from: string;
  to: string;
  reason: "import";
};

export type ImpactGraph = {
  version: number;
  nodes: string[];
  edges: ImpactEdge[];
};

const GRAPH_VERSION = 1;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".ato",
  "dist",
  "coverage",
  ".internal",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const listSourceFiles = async (
  root: string,
  rel: string = "",
): Promise<string[]> => {
  const full = path.join(root, rel);
  const entries = await fs.readdir(full, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const nextRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listSourceFiles(root, nextRel)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(normalizePath(nextRel));
      }
    }
  }
  return results;
};

const parseImports = (content: string): string[] => {
  const imports: string[] = [];
  const pattern =
    /\b(?:import|export)\s+(?:[^'"]+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const spec = match[1];
    if (spec) imports.push(spec);
  }
  return imports;
};

const resolveRelativeImport = (
  filePath: string,
  spec: string,
  fileSet: Set<string>,
): string | null => {
  const fromDir = path.dirname(filePath);
  const base = normalizePath(path.join(fromDir, spec));
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((ext) => `${base}${ext}`),
    ...[...SOURCE_EXTENSIONS].map((ext) => normalizePath(path.join(base, `index${ext}`))),
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
};

export const buildImpactGraph = async ({
  root,
}: {
  root: string;
}): Promise<ImpactGraph> => {
  const files = await listSourceFiles(root);
  files.sort((a, b) => a.localeCompare(b));
  const fileSet = new Set(files);
  const edges: ImpactEdge[] = [];

  for (const file of files) {
    const absolute = path.join(root, file);
    const content = await fs.readFile(absolute, "utf8");
    const imports = parseImports(content);
    for (const spec of imports) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolveRelativeImport(file, spec, fileSet);
      if (!resolved) continue;
      edges.push({ from: file, to: resolved, reason: "import" });
    }
  }

  edges.sort((a, b) => {
    const fromDiff = a.from.localeCompare(b.from);
    if (fromDiff !== 0) return fromDiff;
    const toDiff = a.to.localeCompare(b.to);
    if (toDiff !== 0) return toDiff;
    return a.reason.localeCompare(b.reason);
  });

  return { version: GRAPH_VERSION, nodes: files, edges };
};

export const impactCachePath = (store: string): string =>
  path.join(store, "cache", "impact.graph.json");

export const readImpactGraph = async (
  store: string,
): Promise<ImpactGraph | null> =>
  readJson<ImpactGraph>(impactCachePath(store), null);

export const writeImpactGraph = async (
  store: string,
  graph: ImpactGraph,
): Promise<void> => {
  await writeJson(impactCachePath(store), graph);
};

const isTestFile = (filePath: string): boolean =>
  /(^|\/)(test|tests|__tests__)(\/|$)/.test(filePath) ||
  /(\.|\/)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);

const packageFor = (filePath: string): string => {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts[1]) return parts[1];
  return "root";
};

export const queryImpact = ({
  graph,
  changed,
}: {
  graph: ImpactGraph;
  changed: string[];
}): {
  changed: string[];
  missing: string[];
  impactedFiles: Array<{ path: string; rank: number }>;
  impactedPackages: Array<{ name: string; rank: number }>;
  impactedTests: Array<{ path: string; rank: number }>;
  impactEdges: ImpactEdge[];
} => {
  const nodes = new Set(graph.nodes);
  const missing = changed.filter((entry) => !nodes.has(entry));
  const seeds = changed.filter((entry) => nodes.has(entry));

  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to)?.add(edge.from);
  }

  const ranks = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    ranks.set(seed, 0);
    queue.push(seed);
  }

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const currentRank = ranks.get(current) ?? 0;
    const dependents = reverse.get(current) ?? new Set();
    for (const dependent of dependents) {
      if (ranks.has(dependent)) continue;
      ranks.set(dependent, currentRank + 1);
      queue.push(dependent);
    }
  }

  const impactedFiles = [...ranks.entries()]
    .map(([pathValue, rank]) => ({ path: pathValue, rank }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.path.localeCompare(b.path);
    });

  const impactedTests = impactedFiles
    .filter((entry) => isTestFile(entry.path))
    .map((entry) => ({ path: entry.path, rank: entry.rank }));

  const packageRanks = new Map<string, number>();
  for (const entry of impactedFiles) {
    const pkg = packageFor(entry.path);
    const current = packageRanks.get(pkg);
    if (current === undefined || entry.rank < current) {
      packageRanks.set(pkg, entry.rank);
    }
  }

  const impactedPackages = [...packageRanks.entries()]
    .map(([name, rank]) => ({ name, rank }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.name.localeCompare(b.name);
    });

  const impactedSet = new Set(impactedFiles.map((entry) => entry.path));
  const impactEdges = graph.edges.filter(
    (edge) => impactedSet.has(edge.from) && impactedSet.has(edge.to),
  );

  return {
    changed: seeds,
    missing,
    impactedFiles,
    impactedPackages,
    impactedTests,
    impactEdges,
  };
};

export const listTests = (graph: ImpactGraph): string[] =>
  graph.nodes.filter((node) => isTestFile(node)).sort((a, b) => a.localeCompare(b));
