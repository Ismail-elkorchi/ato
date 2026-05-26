import path from "node:path";
import { promises as fs } from "node:fs";

import { readJson, writeJson } from "../fs.js";

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

export type PackageInfo = {
  name: string;
  path: string;
  manifest: string;
  version?: string | null;
  private?: boolean | null;
};

export type DepEdge = {
  from: string;
  to: string;
  reason: DependencySection;
  spec: string;
};

export type DepsGraph = {
  version: number;
  packages: PackageInfo[];
  edges: DepEdge[];
};

export type DepsCycle = {
  path: string[];
};

export type PackageImpact = {
  name: string;
  rank: number;
  reason: { type: "changed" | "dependency"; via?: string };
};

export type DepsImpact = {
  changedPaths: string[];
  missingPaths: string[];
  changedPackages: string[];
  impactedPackages: PackageImpact[];
  bumpCandidates: PackageImpact[];
  edges: DepEdge[];
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

const DEP_FIELDS: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const listPackageManifests = async (
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
      results.push(...(await listPackageManifests(root, nextRel)));
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(normalizePath(nextRel));
    }
  }
  return results;
};

const toPackageName = (value: unknown, relDir: string): string => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return `path:${normalizePath(relDir || ".")}`;
};

const normalizeDir = (value: string): string =>
  value === "." ? "" : normalizePath(value);

const sortPackages = (packages: PackageInfo[]): PackageInfo[] =>
  packages.slice().sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff !== 0) return nameDiff;
    return a.path.localeCompare(b.path);
  });

export const buildDepsGraph = async ({
  root,
}: {
  root: string;
}): Promise<DepsGraph> => {
  const manifests = await listPackageManifests(root);
  manifests.sort((a, b) => a.localeCompare(b));
  const packages: PackageInfo[] = [];

  for (const manifest of manifests) {
    const absolute = path.join(root, manifest);
    const data = await readJson<Record<string, unknown>>(absolute, {});
    const relDir = normalizeDir(path.dirname(manifest));
    const name = toPackageName(data?.["name"], relDir);
    packages.push({
      name,
      path: relDir,
      manifest,
      version:
        typeof data?.["version"] === "string" ? data["version"] : null,
      private:
        typeof data?.["private"] === "boolean" ? data["private"] : null,
    });
  }

  const sortedPackages = sortPackages(packages);
  const internalNames = new Set(sortedPackages.map((pkg) => pkg.name));
  const edges: DepEdge[] = [];

  for (const pkg of sortedPackages) {
    const absolute = path.join(root, pkg.manifest);
    const data = await readJson<Record<string, unknown>>(absolute, {});
    for (const field of DEP_FIELDS) {
      const deps = data?.[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [depName, spec] of Object.entries(
        deps as Record<string, string>,
      )) {
        if (!internalNames.has(depName)) continue;
        edges.push({
          from: pkg.name,
          to: depName,
          reason: field,
          spec: typeof spec === "string" ? spec : "*",
        });
      }
    }
  }

  edges.sort((a, b) => {
    const fromDiff = a.from.localeCompare(b.from);
    if (fromDiff !== 0) return fromDiff;
    const toDiff = a.to.localeCompare(b.to);
    if (toDiff !== 0) return toDiff;
    const reasonDiff = a.reason.localeCompare(b.reason);
    if (reasonDiff !== 0) return reasonDiff;
    return a.spec.localeCompare(b.spec);
  });

  return { version: GRAPH_VERSION, packages: sortedPackages, edges };
};

export const depsCachePath = (store: string): string =>
  path.join(store, "cache", "deps.graph.json");

export const readDepsGraph = async (
  store: string,
): Promise<DepsGraph | null> => readJson<DepsGraph>(depsCachePath(store), null);

export const writeDepsGraph = async (
  store: string,
  graph: DepsGraph,
): Promise<void> => {
  await writeJson(depsCachePath(store), graph);
};

const normalizeCyclePath = (cycle: string[]): string[] => {
  const path =
    cycle.length > 1 && cycle[0] === cycle[cycle.length - 1]
      ? cycle.slice(0, -1)
      : cycle.slice();
  const rotations = path.map((_, idx) => [
    ...path.slice(idx),
    ...path.slice(0, idx),
  ]);
  rotations.sort((a, b) => a.join(">").localeCompare(b.join(">")));
  const best = rotations[0] ?? path;
  const reversed = best.slice().reverse();
  const candidates = [best, reversed];
  candidates.sort((a, b) => a.join(">").localeCompare(b.join(">")));
  const chosen = candidates[0] ?? best;
  const head = chosen[0];
  if (!head) return [];
  return [...chosen, head];
};

export const detectDepsCycles = (graph: DepsGraph): DepsCycle[] => {
  const adjacency = new Map<string, string[]>();
  for (const pkg of graph.packages) {
    adjacency.set(pkg.name, []);
  }
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  for (const [name, list] of adjacency.entries()) {
    list.sort((a, b) => a.localeCompare(b));
    adjacency.set(name, list);
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const cycles: DepsCycle[] = [];

  const visit = (node: string): void => {
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visit(neighbor);
        continue;
      }
      if (onStack.has(neighbor)) {
        const startIndex = stack.indexOf(neighbor);
        if (startIndex >= 0) {
          const raw = [...stack.slice(startIndex), neighbor];
          const normalized = normalizeCyclePath(raw);
          const key = normalized.join(">");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ path: normalized });
          }
        }
      }
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const pkg of graph.packages) {
    if (!visited.has(pkg.name)) {
      visit(pkg.name);
    }
  }

  cycles.sort((a, b) => a.path.join(">").localeCompare(b.path.join(">")));
  return cycles;
};

const sortByDepth = (packages: PackageInfo[]): PackageInfo[] =>
  packages.slice().sort((a, b) => {
    const depthDiff = b.path.length - a.path.length;
    if (depthDiff !== 0) return depthDiff;
    return a.path.localeCompare(b.path);
  });

const resolvePackageForPath = (
  packages: PackageInfo[],
  filePath: string,
): PackageInfo | null => {
  if (!packages.length) return null;
  const normalized = normalizePath(filePath);
  for (const pkg of sortByDepth(packages)) {
    if (!pkg.path) return pkg;
    if (normalized === pkg.path || normalized.startsWith(`${pkg.path}/`)) {
      return pkg;
    }
  }
  return null;
};

export const resolveDepsImpact = ({
  graph,
  changedPaths,
}: {
  graph: DepsGraph;
  changedPaths: string[];
}): DepsImpact => {
  const missingPaths: string[] = [];
  const changedPackages: string[] = [];
  const packages = graph.packages;

  for (const filePath of changedPaths) {
    const pkg = resolvePackageForPath(packages, filePath);
    if (!pkg) {
      missingPaths.push(filePath);
      continue;
    }
    changedPackages.push(pkg.name);
  }

  const uniqueChanged = Array.from(new Set(changedPackages)).sort((a, b) =>
    a.localeCompare(b),
  );
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to)?.add(edge.from);
  }

  const ranks = new Map<string, number>();
  const reasons = new Map<string, PackageImpact["reason"]>();
  const queue: string[] = [];
  for (const seed of uniqueChanged) {
    ranks.set(seed, 0);
    reasons.set(seed, { type: "changed" });
    queue.push(seed);
  }

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const currentRank = ranks.get(current) ?? 0;
    const dependents = Array.from(reverse.get(current) ?? []).sort((a, b) =>
      a.localeCompare(b),
    );
    for (const dependent of dependents) {
      if (ranks.has(dependent)) continue;
      ranks.set(dependent, currentRank + 1);
      reasons.set(dependent, { type: "dependency", via: current });
      queue.push(dependent);
    }
  }

  const impactedPackages: PackageImpact[] = Array.from(ranks.entries())
    .map(([name, rank]) => ({
      name,
      rank,
      reason: reasons.get(name) ?? { type: "dependency" },
    }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.name.localeCompare(b.name);
    });

  const bumpCandidates: PackageImpact[] = impactedPackages.map((entry) => {
    const reason: PackageImpact["reason"] =
      entry.reason.type === "changed"
        ? { type: "changed" }
        : entry.reason.via
          ? { type: "dependency", via: entry.reason.via }
          : { type: "dependency" };
    return { ...entry, reason };
  });

  return {
    changedPaths,
    missingPaths,
    changedPackages: uniqueChanged,
    impactedPackages,
    bumpCandidates,
    edges: graph.edges,
  };
};
