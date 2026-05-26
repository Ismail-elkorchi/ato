import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import ts from "typescript";

import { ensureDir } from "../fs.js";
import { getRollbackBundlePath, getRollbackDir } from "../runlog.js";
import { collectSourceFiles, renameInFile } from "../ast/rename.js";
import type { RenameFileResult } from "../ast/rename.js";

type ApiSymbol = {
  path: string;
  name: string;
};

export type ApiDelta = {
  added: ApiSymbol[];
  removed: ApiSymbol[];
};

export type RefactorRenameFile = {
  path: string;
  changes: RenameFileResult["changes"];
  before: string;
  after: string;
  diff: string[];
  apiBefore: string[];
  apiAfter: string[];
};

export type RefactorRenamePlan = {
  from: string;
  to: string;
  files: RefactorRenameFile[];
  impactedFiles: string[];
  apiDelta: ApiDelta;
  summary: {
    filesChanged: number;
    replacements: number;
  };
};

type RollbackBundleFile = {
  path: string;
  before: string;
  beforeHash: string;
  afterHash: string;
};

export type RollbackBundle = {
  version: 1;
  id: string;
  kind: "refactor.rename";
  from: string;
  to: string;
  files: RollbackBundleFile[];
  apiDelta: ApiDelta;
  summary: {
    filesChanged: number;
    replacements: number;
  };
};

const EXT_TO_KIND: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

const hashContent = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const getScriptKind = (filePath: string): ts.ScriptKind =>
  EXT_TO_KIND[path.extname(filePath)] ?? ts.ScriptKind.TS;

const collectExportedNames = (content: string, filePath: string): string[] => {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isExportAssignment(node)) {
      names.add(node.isExportEquals ? "export=" : "default");
    }

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          names.add(element.name.text);
        }
      } else if (!node.exportClause && node.moduleSpecifier) {
        const moduleName = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        names.add(moduleName ? `*:${moduleName}` : "*");
      }
    }

    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : null;
    const hasExport = modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (hasExport) {
      const hasDefault = modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (hasDefault) {
        names.add("default");
      }
      if (!hasDefault) {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)
        ) {
          if (node.name) names.add(node.name.text);
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              names.add(decl.name.text);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...names].sort((a, b) => a.localeCompare(b));
};

const buildApiDelta = (files: RefactorRenameFile[]): ApiDelta => {
  const added: ApiSymbol[] = [];
  const removed: ApiSymbol[] = [];

  for (const file of files) {
    const before = new Set(file.apiBefore);
    const after = new Set(file.apiAfter);
    for (const name of after) {
      if (!before.has(name)) {
        added.push({ path: file.path, name });
      }
    }
    for (const name of before) {
      if (!after.has(name)) {
        removed.push({ path: file.path, name });
      }
    }
  }

  added.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  removed.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));

  return { added, removed };
};

const buildLineDiff = (before: string, after: string): string[] => {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const diff: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const beforeLine = beforeLines[i];
    const afterLine = afterLines[i];
    if (beforeLine === afterLine) continue;
    if (beforeLine !== undefined) {
      diff.push(`-${i + 1}|${beforeLine}`);
    }
    if (afterLine !== undefined) {
      diff.push(`+${i + 1}|${afterLine}`);
    }
  }
  return diff;
};

export const planRenameRefactor = async ({
  root,
  paths,
  from,
  to,
}: {
  root: string;
  paths: string[];
  from: string;
  to: string;
}): Promise<RefactorRenamePlan> => {
  const files = await collectSourceFiles({ root, paths });
  const results: RefactorRenameFile[] = [];

  for (const filePath of files) {
    const result = await renameInFile({
      root,
      filePath,
      from,
      to,
    });
    if (!result) continue;
    const before = result.prevContent;
    const after = result.nextContent;
    results.push({
      path: result.path,
      changes: result.changes,
      before,
      after,
      diff: buildLineDiff(before, after),
      apiBefore: collectExportedNames(before, filePath),
      apiAfter: collectExportedNames(after, filePath),
    });
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  const impactedFiles = results.map((entry) => entry.path);
  const summary = {
    filesChanged: results.length,
    replacements: results.reduce((sum, entry) => sum + entry.changes.length, 0),
  };

  return {
    from,
    to,
    files: results,
    impactedFiles,
    apiDelta: buildApiDelta(results),
    summary,
  };
};

export const createRollbackBundle = async ({
  store,
  plan,
}: {
  store: string;
  plan: RefactorRenamePlan;
}): Promise<{ bundle: RollbackBundle; bundlePath: string; dir: string }> => {
  const orderedFiles = [...plan.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const files = orderedFiles.map((file) => ({
    path: file.path,
    before: file.before,
    beforeHash: hashContent(file.before),
    afterHash: hashContent(file.after),
  }));
  const payload = {
    version: 1 as const,
    kind: "refactor.rename" as const,
    from: plan.from,
    to: plan.to,
    files,
    apiDelta: plan.apiDelta,
    summary: plan.summary,
  };
  const id = hashContent(JSON.stringify(payload)).slice(0, 12);
  const bundle: RollbackBundle = { id, ...payload };
  const dir = getRollbackDir(store, id);
  await ensureDir(dir);
  const bundlePath = getRollbackBundlePath(store, id);
  await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundle, bundlePath, dir };
};

export const applyRenamePlan = async ({
  root,
  plan,
}: {
  root: string;
  plan: RefactorRenamePlan;
}): Promise<void> => {
  for (const file of plan.files) {
    await fs.writeFile(path.join(root, file.path), file.after, "utf8");
  }
};

export const loadRollbackBundle = async ({
  store,
  id,
}: {
  store: string;
  id: string;
}): Promise<{ bundle: RollbackBundle; bundlePath: string }> => {
  const bundlePath = getRollbackBundlePath(store, id);
  const raw = await fs.readFile(bundlePath, "utf8");
  const bundle = JSON.parse(raw) as RollbackBundle;
  return { bundle, bundlePath };
};

export const applyRollbackBundle = async ({
  root,
  bundle,
}: {
  root: string;
  bundle: RollbackBundle;
}): Promise<Array<{ path: string; matched: boolean; currentHash: string | null }>> => {
  const restored: Array<{ path: string; matched: boolean; currentHash: string | null }> = [];
  const ordered = [...bundle.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    const absolute = path.join(root, file.path);
    let currentHash: string | null = null;
    let matched = false;
    try {
      const current = await fs.readFile(absolute, "utf8");
      currentHash = hashContent(current);
      matched = currentHash === file.afterHash;
    } catch {
      matched = false;
    }
    await ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, file.before, "utf8");
    restored.push({ path: file.path, matched, currentHash });
  }
  return restored;
};
