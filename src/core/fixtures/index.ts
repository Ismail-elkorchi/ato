import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import ts from "typescript";

export type FixtureVariant = {
  name: "base" | "edge";
  value: unknown;
};

export type FixtureResult = {
  seed: string;
  file: string;
  type: string;
  variants: FixtureVariant[];
};

const MAX_DEPTH = 5;

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const stableSeed = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);

const readTsConfig = (
  root: string,
): { options: ts.CompilerOptions; fileNames: string[] } | null => {
  const configPath = path.join(root, "tsconfig.json");
  try {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) return null;
    const config = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      root,
    );
    return { options: config.options, fileNames: config.fileNames };
  } catch {
    return null;
  }
};

const findTypeNode = (
  sourceFile: ts.SourceFile,
  typeName: string,
): ts.Declaration | null => {
  let found: ts.Declaration | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name?.text === typeName) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

const typeToStringSafe = (checker: ts.TypeChecker, type: ts.Type): string =>
  checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);

const sortTypes = (checker: ts.TypeChecker, types: ts.Type[]): ts.Type[] =>
  [...types].sort((a, b) =>
    typeToStringSafe(checker, a).localeCompare(typeToStringSafe(checker, b)),
  );

const buildLiteralValue = (type: ts.Type): unknown => {
  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const literal = type as ts.BigIntLiteralType;
    return BigInt(literal.value.negative ? `-${literal.value.base10Value}` : literal.value.base10Value);
  }
  return null;
};

const buildPrimitiveValue = (
  type: ts.Type,
  variant: "base" | "edge",
): unknown => {
  if (type.flags & ts.TypeFlags.String) {
    return variant === "edge" ? "edge" : "string";
  }
  if (type.flags & ts.TypeFlags.Number) {
    return variant === "edge" ? 1 : 0;
  }
  if (type.flags & ts.TypeFlags.Boolean) {
    return variant === "edge";
  }
  if (type.flags & ts.TypeFlags.BigInt) {
    return variant === "edge" ? BigInt(1) : BigInt(0);
  }
  if (type.flags & ts.TypeFlags.Null) return null;
  if (type.flags & ts.TypeFlags.Undefined) return null;
  if (type.flags & ts.TypeFlags.Any) return null;
  if (type.flags & ts.TypeFlags.Unknown) return null;
  return null;
};

const buildArrayValue = (
  elementType: ts.Type,
  checker: ts.TypeChecker,
  variant: "base" | "edge",
  depth: number,
  seen: Set<ts.Type>,
  contextNode: ts.Node,
): unknown[] => {
  if (variant === "edge") {
    return [
      buildValue(elementType, checker, variant, depth + 1, seen, contextNode),
    ];
  }
  return [];
};

const buildObjectValue = (
  type: ts.Type,
  checker: ts.TypeChecker,
  variant: "base" | "edge",
  depth: number,
  seen: Set<ts.Type>,
  contextNode: ts.Node,
): Record<string, unknown> => {
  const properties = checker.getPropertiesOfType(type);
  const ordered = [...properties].sort((a, b) => a.name.localeCompare(b.name));
  const result: Record<string, unknown> = {};

  for (const prop of ordered) {
    const isOptional = Boolean(prop.flags & ts.SymbolFlags.Optional);
    if (isOptional && variant === "base") continue;
    const decl = prop.valueDeclaration ?? prop.declarations?.[0] ?? contextNode;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    result[prop.name] = buildValue(
      propType,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
  }

  const indexType = type.getStringIndexType();
  if (!ordered.length && indexType) {
    result["key"] = buildValue(
      indexType,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
  }

  return result;
};

const buildValue = (
  type: ts.Type,
  checker: ts.TypeChecker,
  variant: "base" | "edge",
  depth: number,
  seen: Set<ts.Type>,
  contextNode: ts.Node,
): unknown => {
  if (depth > MAX_DEPTH) return null;
  if (seen.has(type)) return null;
  seen.add(type);

  if (type.isUnion()) {
    const sorted = sortTypes(checker, type.types);
    const chosen =
      variant === "edge" ? sorted[sorted.length - 1] : sorted[0];
    if (!chosen) return null;
    const value = buildValue(
      chosen,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
    seen.delete(type);
    return value;
  }

  if (type.isIntersection()) {
    const value = buildObjectValue(
      type,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
    seen.delete(type);
    return value;
  }

  const literal = buildLiteralValue(type);
  if (literal !== null) {
    seen.delete(type);
    return literal;
  }

  const primitive = buildPrimitiveValue(type, variant);
  if (primitive !== null) {
    seen.delete(type);
    return primitive;
  }

  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    if (!element) {
      seen.delete(type);
      return [];
    }
    const value = buildArrayValue(
      element,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
    seen.delete(type);
    return value;
  }

  if (checker.isTupleType(type)) {
    const tuple = type as ts.TupleType;
    const elements = tuple.typeArguments ?? [];
    const value = elements.map((entry) =>
      buildValue(entry, checker, variant, depth + 1, seen, contextNode),
    );
    seen.delete(type);
    return value;
  }

  if (type.flags & ts.TypeFlags.EnumLike) {
    const symbol = type.getSymbol();
    const members = symbol?.exports ? [...symbol.exports.values()] : [];
    const ordered = members
      .map((member) => member.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (ordered.length) {
      seen.delete(type);
      return ordered[0];
    }
  }

  if (type.getCallSignatures().length || type.getConstructSignatures().length) {
    throw new Error("Fixture generation does not support function types.");
  }

  if (type.flags & ts.TypeFlags.Object) {
    const value = buildObjectValue(
      type,
      checker,
      variant,
      depth + 1,
      seen,
      contextNode,
    );
    seen.delete(type);
    return value;
  }

  seen.delete(type);
  return null;
};

export const generateFixture = async ({
  root,
  filePath,
  typeName,
  includeEdge,
}: {
  root: string;
  filePath: string;
  typeName: string;
  includeEdge: boolean;
}): Promise<FixtureResult> => {
  const resolvedPath = path.resolve(root, filePath);
  const relPath = normalizePath(path.relative(root, resolvedPath));
  if (!relPath || relPath.startsWith("..")) {
    throw new Error(`Fixture source must be within target root: ${filePath}`);
  }

  await fs.access(resolvedPath);

  const config = readTsConfig(root);
  const program = config
    ? ts.createProgram({ rootNames: config.fileNames, options: config.options })
    : ts.createProgram({
        rootNames: [resolvedPath],
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          allowJs: true,
        },
      });

  const sourceFile = program.getSourceFile(resolvedPath);
  if (!sourceFile) {
    throw new Error(`Unable to load source file: ${relPath || resolvedPath}`);
  }

  const node = findTypeNode(sourceFile, typeName);
  if (!node) {
    throw new Error(`Type '${typeName}' not found in ${relPath || resolvedPath}.`);
  }

  const checker = program.getTypeChecker();
  const type = checker.getTypeAtLocation(node);
  const seed = stableSeed(`${typeName}:${relPath}`);

  const baseValue = buildValue(type, checker, "base", 0, new Set(), sourceFile);
  const variants: FixtureVariant[] = [
    { name: "base", value: baseValue },
  ];

  if (includeEdge) {
    const edgeValue = buildValue(type, checker, "edge", 0, new Set(), sourceFile);
    variants.push({ name: "edge", value: edgeValue });
  }

  return {
    seed,
    file: relPath || normalizePath(resolvedPath),
    type: typeName,
    variants,
  };
};
