import path from "node:path";

import { readJson, writeJson } from "../fs.js";
import { buildDepsGraph } from "../deps/index.js";

export type EntityNode = {
  id: string;
  type: "repo" | "package";
  name: string;
  path?: string;
};

export type EntityEdge = {
  from: string;
  to: string;
  relation: "contains" | "depends_on";
};

export type EntityGraph = {
  version: number;
  generatedAt: string;
  nodes: EntityNode[];
  edges: EntityEdge[];
};

const GRAPH_VERSION = 1;

const entityDir = (store: string): string => path.join(store, "memory", "entity");

export const entityGraphPath = (store: string): string =>
  path.join(entityDir(store), "graph.json");

export const buildEntityGraph = async ({
  root,
  store,
}: {
  root: string;
  store: string;
}): Promise<EntityGraph> => {
  const pkg = await readJson<Record<string, unknown>>(
    path.join(root, "package.json"),
    {},
  );
  const repoName =
    typeof pkg?.["name"] === "string" ? pkg["name"] : path.basename(root);
  const repoId = `repo:${repoName}`;

  const depsGraph = await buildDepsGraph({ root });
  const nodes: EntityNode[] = [
    { id: repoId, type: "repo", name: repoName, path: "." },
  ];

  for (const pkgInfo of depsGraph.packages) {
    nodes.push({
      id: `package:${pkgInfo.name}`,
      type: "package",
      name: pkgInfo.name,
      path: pkgInfo.path || ".",
    });
  }

  const edges: EntityEdge[] = [];
  for (const pkgInfo of depsGraph.packages) {
    edges.push({
      from: repoId,
      to: `package:${pkgInfo.name}`,
      relation: "contains",
    });
  }

  for (const dep of depsGraph.edges) {
    edges.push({
      from: `package:${dep.from}`,
      to: `package:${dep.to}`,
      relation: "depends_on",
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => {
    const fromDiff = a.from.localeCompare(b.from);
    if (fromDiff !== 0) return fromDiff;
    const toDiff = a.to.localeCompare(b.to);
    if (toDiff !== 0) return toDiff;
    return a.relation.localeCompare(b.relation);
  });

  const graph: EntityGraph = {
    version: GRAPH_VERSION,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };

  await writeJson(entityGraphPath(store), graph);
  return graph;
};

export const readEntityGraph = async (
  store: string,
): Promise<EntityGraph | null> => readJson<EntityGraph>(entityGraphPath(store), null);

export const queryEntityGraph = ({
  graph,
  name,
}: {
  graph: EntityGraph;
  name?: string | null;
}): { nodes: EntityNode[]; edges: EntityEdge[] } => {
  if (!name) {
    return { nodes: graph.nodes, edges: graph.edges };
  }
  const normalized = name.toLowerCase();
  const nodes = graph.nodes.filter((node) =>
    node.name.toLowerCase().includes(normalized),
  );
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => ids.has(edge.from) || ids.has(edge.to),
  );
  return { nodes, edges };
};
