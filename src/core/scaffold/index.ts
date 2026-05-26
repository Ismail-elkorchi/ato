import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir } from "../fs.js";

export type ScaffoldSpec = {
  name: string;
  summary?: string;
  description?: string;
  usage?: string;
  outputs?: {
    command?: boolean;
    core?: boolean;
    test?: boolean;
    doc?: boolean;
  };
  paths?: {
    command?: string;
    core?: string;
    test?: string;
    doc?: string;
  };
};

type ScaffoldOutput = {
  kind: "command" | "core" | "test" | "doc";
  path: string;
};

export type ScaffoldPlanEntry = ScaffoldOutput & {
  template: string;
};

type ScaffoldPlanItem = ScaffoldOutput & {
  templatePath: string;
  fullPath: string;
  content: string;
};

const TEMPLATE_ORDER: Array<ScaffoldOutput["kind"]> = [
  "command",
  "core",
  "test",
  "doc",
];

const TEMPLATE_FILES: Record<ScaffoldOutput["kind"], string> = {
  command: "command.ts.tpl",
  core: "core.ts.tpl",
  test: "test.js.tpl",
  doc: "doc.md.tpl",
};

const toTokens = (name: string): string[] =>
  name
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const toSlug = (name: string): string =>
  toTokens(name)
    .map((token) => token.toLowerCase())
    .join("-");

const toPascal = (name: string): string =>
  toTokens(name)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join("");

const toCamel = (name: string): string => {
  const pascal = toPascal(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const resolveOutputPath = (root: string, value: string): { full: string; rel: string } => {
  const full = path.resolve(root, value);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Output path must be within target root: ${value}`);
  }
  return { full, rel: normalizePath(relative) };
};

const renderTemplate = (content: string, tokens: Record<string, string>): string =>
  content.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) =>
    tokens[key] ?? "",
  );

export const scaffoldFromSpec = async ({
  root,
  spec,
  templatesRoot,
  dryRun = false,
}: {
  root: string;
  spec: ScaffoldSpec;
  templatesRoot: string;
  dryRun?: boolean;
}): Promise<{ outputs: ScaffoldOutput[]; plan: ScaffoldPlanEntry[] }> => {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("Scaffold spec must be a JSON object.");
  }
  const rawName = String(spec.name ?? "").trim();
  if (!rawName) {
    throw new Error("Scaffold spec requires a non-empty name.");
  }

  const slug = toSlug(rawName);
  if (!slug) {
    throw new Error("Scaffold name must include alphanumeric characters.");
  }
  const pascalName = toPascal(rawName);
  const camelName = toCamel(rawName);
  const summary = String(spec.summary ?? "").trim();
  if (!summary) {
    const error = new Error("Scaffold spec requires a non-empty summary.");
    (error as Error & { code?: number }).code = 3;
    throw error;
  }
  const description = String(spec.description ?? "").trim();
  if (!description) {
    const error = new Error("Scaffold spec requires a non-empty description.");
    (error as Error & { code?: number }).code = 3;
    throw error;
  }
  const usage = String(spec.usage ?? "").trim();
  if (!usage) {
    const error = new Error("Scaffold spec requires non-empty usage.");
    (error as Error & { code?: number }).code = 3;
    throw error;
  }

  const tokens = {
    name: rawName,
    slug,
    pascalName,
    camelName,
    summary,
    description,
    usage,
  };

  const defaults = {
    command: `src/cli/commands/${slug}.ts`,
    core: `src/core/${slug}/index.ts`,
    test: `test/${slug}.test.js`,
    doc: `docs/${slug}.md`,
  };

  const outputOptions: NonNullable<ScaffoldSpec["outputs"]> =
    spec.outputs && typeof spec.outputs === "object" && !Array.isArray(spec.outputs)
      ? spec.outputs
      : {};
  const paths: NonNullable<ScaffoldSpec["paths"]> =
    spec.paths && typeof spec.paths === "object" && !Array.isArray(spec.paths)
      ? spec.paths
      : {};

  const outputFlags = {
    command: outputOptions.command ?? true,
    core: outputOptions.core ?? true,
    test: outputOptions.test ?? true,
    doc: outputOptions.doc ?? true,
  };

  const plan: ScaffoldPlanItem[] = [];
  for (const kind of TEMPLATE_ORDER) {
    if (!outputFlags[kind]) continue;
    const templatePath = path.join(templatesRoot, TEMPLATE_FILES[kind]);
    const template = await fs.readFile(templatePath, "utf8");
    const rendered = renderTemplate(template, tokens);
    const rawPath = paths[kind] ?? defaults[kind];
    const resolved = resolveOutputPath(root, rawPath);
    plan.push({
      kind,
      path: resolved.rel,
      templatePath,
      fullPath: resolved.full,
      content: rendered,
    });
  }

  for (const item of plan) {
    try {
      await fs.stat(item.fullPath);
      throw new Error(`Output already exists: ${item.path}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") {
        throw error;
      }
    }
  }

  const outputs = plan.map(({ kind, path: outputPath }) => ({
    kind,
    path: outputPath,
  }));
  const planEntries = plan.map(({ kind, path: outputPath, templatePath }) => ({
    kind,
    path: outputPath,
    template: normalizePath(path.relative(root, templatePath)),
  }));

  if (!dryRun) {
    for (const item of plan) {
      await ensureDir(path.dirname(item.fullPath));
      await fs.writeFile(item.fullPath, item.content, "utf8");
    }
  }

  return { outputs, plan: planEntries };
};
