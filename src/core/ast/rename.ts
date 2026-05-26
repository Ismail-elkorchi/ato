import path from "node:path";
import { promises as fs } from "node:fs";
import ts from "typescript";

type RenameChange = {
  line: number;
  column: number;
  before: string;
  after: string;
  start: number;
  end: number;
};

export type RenameFileResult = {
  path: string;
  changes: RenameChange[];
  prevContent: string;
  nextContent: string;
};

const EXT_TO_KIND: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const shouldRename = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
};

const applyReplacements = (
  content: string,
  replacements: RenameChange[],
): string => {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let updated = content;
  for (const replacement of ordered) {
    updated =
      updated.slice(0, replacement.start) +
      replacement.after +
      updated.slice(replacement.end);
  }
  return updated;
};

export const renameInFile = async ({
  root,
  filePath,
  from,
  to,
}: {
  root: string;
  filePath: string;
  from: string;
  to: string;
}): Promise<RenameFileResult | null> => {
  const absolute = path.join(root, filePath);
  const content = await fs.readFile(absolute, "utf8");
  const ext = path.extname(filePath);
  const kind = EXT_TO_KIND[ext] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );

  const changes: RenameChange[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === from && shouldRename(node)) {
      const start = node.getStart(sourceFile, false);
      const end = node.getEnd();
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      changes.push({
        line: position.line + 1,
        column: position.character + 1,
        before: from,
        after: to,
        start,
        end,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!changes.length) return null;
  const nextContent = applyReplacements(content, changes);
  return {
    path: normalizePath(filePath),
    changes,
    prevContent: content,
    nextContent,
  };
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".ato",
  "dist",
  "coverage",
  ".internal",
]);

const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_KIND));

export const collectSourceFiles = async ({
  root,
  paths,
}: {
  root: string;
  paths: string[];
}): Promise<string[]> => {
  const results: string[] = [];
  const visitDir = async (rel: string) => {
    const full = path.join(root, rel);
    const entries = await fs.readdir(full, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const nextRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await visitDir(nextRel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(normalizePath(nextRel));
        }
      }
    }
  };

  for (const input of paths) {
    const rel = normalizePath(path.relative(root, path.resolve(root, input)));
    const full = path.join(root, rel);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await visitDir(rel);
      } else if (stat.isFile()) {
        const ext = path.extname(rel);
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(normalizePath(rel));
        }
      }
    } catch {
      // Ignore missing paths; caller can validate separately.
    }
  }

  return [...new Set(results)].sort((a, b) => a.localeCompare(b));
};
