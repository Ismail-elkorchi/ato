import path from "node:path";
import { promises as fs } from "node:fs";

import type { CapabilityEntry } from "../capability/manifest.js";

export type DocReference = {
  path: string;
  line: number;
  column: number;
};

export type ExportReference = {
  id: string;
  command: string;
  subcommand: string | null;
  source: {
    path: string;
    line: number;
  };
};

export type MissingDocFinding = {
  id: string;
  command: string;
  subcommand: string | null;
  source: ExportReference["source"];
  missingIn: string[];
  action: string;
};

export type RemovedExportFinding = {
  command: string;
  subcommand: string | null;
  docRefs: DocReference[];
};

export type ComplianceReport = {
  exports: ExportReference[];
  missingDocs: MissingDocFinding[];
  removedExports: RemovedExportFinding[];
  docs: {
    required: string[];
    optional: string[];
  };
  summary: {
    totalExports: number;
    missingDocs: number;
    removedExports: number;
  };
};

export type ComplianceDoc = {
  path: string;
  required: boolean;
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const keyFor = (command: string, subcommand: string | null): string =>
  `${command}:${subcommand ?? ""}`;

const splitKey = (
  key: string,
): { command: string; subcommand: string | null } => {
  const [commandRaw, subcommand] = key.split(":");
  const command = commandRaw ?? "";
  return { command, subcommand: subcommand || null };
};

const INLINE_CODE_REGEX = /`([^`]+)`/g;
const TOKEN_REGEX = /^[a-z0-9-]+$/i;
const CODE_FENCE_REGEX = /^\s*```/;
const IGNORED_COMMAND_TOKENS = new Set(["is", "lives", "install", "run"]);

const normalizeToken = (token: string | undefined): string | null => {
  if (!token) return null;
  const cleaned = token.replace(/^[`$]+/, "").replace(/[`;,.:]+$/, "");
  if (!cleaned || cleaned.startsWith("-")) return null;
  if (!TOKEN_REGEX.test(cleaned)) return null;
  return cleaned.toLowerCase();
};

const splitVariants = (token: string | undefined): string[] => {
  if (!token || !token.includes("|")) return [];
  return token
    .split("|")
    .map((part) => normalizeToken(part))
    .filter((part): part is string => Boolean(part));
};

const collectSubcommandTokens = (
  tokenMatches: RegExpMatchArray[],
  startIndex: number,
): string[] => {
  const tokens: string[] = [];
  let skipNext = false;

  for (let i = startIndex; i < tokenMatches.length; i += 1) {
    const raw = tokenMatches[i]?.[0] ?? "";
    if (!raw) continue;

    if (skipNext) {
      skipNext = false;
      if (raw.startsWith("-")) {
        if (!raw.includes("=")) skipNext = true;
      }
      continue;
    }

    if (raw.startsWith("-")) {
      if (!raw.includes("=")) skipNext = true;
      continue;
    }

    const upper = raw.toUpperCase();
    if (upper.startsWith("BL-") && raw.includes("#")) {
      continue;
    }
    if (raw.includes("{") || raw.includes("}") || raw.includes("[") || raw.includes("]")) {
      continue;
    }

    tokens.push(raw);
    if (tokens.length >= 2) break;
  }

  return tokens;
};

const selectSubcommand = ({
  command,
  first,
  second,
  exportKeys,
  commandOnly,
}: {
  command: string;
  first: string | null;
  second: string | null;
  exportKeys: Map<string, ExportReference>;
  commandOnly: Set<string>;
}): string | null | undefined => {
  const candidate1 = first;
  const candidate2 = first && second ? `${first} ${second}` : null;
  if (candidate2 && exportKeys.has(keyFor(command, candidate2))) return candidate2;
  if (candidate1 && exportKeys.has(keyFor(command, candidate1))) return candidate1;
  if (commandOnly.has(command)) return null;
  if (candidate2) return candidate2;
  if (candidate1) return candidate1;
  return undefined;
};

const isPlaceholderSubcommand = (
  command: string,
  first: string | null,
  second: string | null,
): boolean => {
  if (command === "user" && first === "guide") return true;
  if (command === "package" && first === "root") return true;
  if (first === "user" && second === "guide") return true;
  if (first === "package" && second === "root") return true;
  return false;
};

const scanDocForCommands = (
  docPath: string,
  content: string,
  exportKeys: Map<string, ExportReference>,
  commandOnly: Set<string>,
): Map<string, DocReference[]> => {
  const lines = content.split(/\r?\n/);
  const refs = new Map<string, DocReference[]>();
  let inFence = false;

  lines.forEach((line, index) => {
    if (CODE_FENCE_REGEX.test(line.trim())) {
      inFence = !inFence;
      return;
    }
    if (!inFence && line.trim().startsWith("#")) {
      return;
    }

    const segments: Array<{ text: string; offset: number }> = [];
    if (inFence) {
      segments.push({ text: line, offset: 0 });
    } else {
      for (const match of line.matchAll(INLINE_CODE_REGEX)) {
        const text = match[1];
        if (!text) continue;
        const offset = typeof match.index === "number" ? match.index + 1 : 0;
        segments.push({ text, offset });
      }
    }

    for (const segment of segments) {
      const tokenMatches = Array.from(segment.text.matchAll(/\S+/g));
      for (let i = 0; i < tokenMatches.length; i += 1) {
        const current = tokenMatches[i]?.[0] ?? "";
        if (current.toLowerCase() !== "ato") continue;
        const prev = tokenMatches[i - 1]?.[0];
        if (i > 0 && prev !== "$") continue;
        const column =
          (typeof tokenMatches[i]?.index === "number"
            ? tokenMatches[i]?.index ?? 0
            : 0) +
          segment.offset +
          1;

        const command = normalizeToken(tokenMatches[i + 1]?.[0]);
        if (!command) continue;
        if (IGNORED_COMMAND_TOKENS.has(command)) continue;

        const [rawFirst, rawSecond] = collectSubcommandTokens(tokenMatches, i + 2);
        const variants = splitVariants(rawFirst);
        const addRef = (subcommand: string | null) => {
          const key = keyFor(command, subcommand);
          const entry: DocReference = {
            path: docPath,
            line: index + 1,
            column,
          };
          const list = refs.get(key) ?? [];
          list.push(entry);
          refs.set(key, list);
        };

        if (variants.length) {
          for (const variant of variants) {
            addRef(variant);
          }
          continue;
        }

        const first = normalizeToken(rawFirst);
        const second = normalizeToken(rawSecond);
        if (isPlaceholderSubcommand(command, first, second)) continue;

        const selected = selectSubcommand({
          command,
          first,
          second,
          exportKeys,
          commandOnly,
        });
        if (selected === undefined) continue;
        addRef(selected);
      }
    }
  });

  for (const list of refs.values()) {
    list.sort((a, b) => a.line - b.line || a.column - b.column);
  }
  return refs;
};

const buildIdLineMap = (content: string): Map<string, number> => {
  const map = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/id:\s*"([^"]+)"/);
    if (match) {
      const id = match[1];
      if (id) {
        map.set(id, index + 1);
      }
    }
  });
  return map;
};

export const buildComplianceReport = async ({
  root,
  manifestPath,
  capabilities,
  docs,
}: {
  root: string;
  manifestPath: string;
  capabilities: CapabilityEntry[];
  docs: ComplianceDoc[];
}): Promise<ComplianceReport> => {
  const manifestContent = await fs.readFile(manifestPath, "utf8");
  const idLines = buildIdLineMap(manifestContent);
  const manifestRel = normalizePath(path.relative(root, manifestPath));

  const exports: ExportReference[] = capabilities.map((entry) => {
    const line = idLines.get(entry.id) ?? 1;
    return {
      id: entry.id,
      command: entry.command,
      subcommand: entry.subcommand ?? null,
      source: {
        path: manifestRel || normalizePath(manifestPath),
        line,
      },
    };
  });

  exports.sort(
    (a, b) =>
      a.command.localeCompare(b.command) ||
      String(a.subcommand ?? "").localeCompare(String(b.subcommand ?? "")) ||
      a.id.localeCompare(b.id),
  );

  const docMaps = new Map<string, Map<string, DocReference[]>>();
  const requiredDocs: string[] = [];
  const optionalDocs: string[] = [];

  const exportKeys = new Map<string, ExportReference>();
  const commandOnly = new Set<string>();
  for (const entry of exports) {
    exportKeys.set(keyFor(entry.command, entry.subcommand), entry);
    if (!entry.subcommand) commandOnly.add(entry.command);
  }

  for (const doc of docs) {
    const resolved = path.resolve(root, doc.path);
    const content = await fs.readFile(resolved, "utf8").catch(() => "");
    const rel = normalizePath(path.relative(root, resolved));
    const displayPath = rel || normalizePath(resolved);
    if (doc.required) {
      requiredDocs.push(displayPath);
    } else {
      optionalDocs.push(displayPath);
    }
    docMaps.set(
      displayPath,
      scanDocForCommands(displayPath, content, exportKeys, commandOnly),
    );
  }

  requiredDocs.sort((a, b) => a.localeCompare(b));
  optionalDocs.sort((a, b) => a.localeCompare(b));

  const missingDocs: MissingDocFinding[] = [];
  for (const entry of exports) {
    const missingIn: string[] = [];
    for (const docPath of requiredDocs) {
      const map = docMaps.get(docPath);
      if (!map?.has(keyFor(entry.command, entry.subcommand))) {
        missingIn.push(docPath);
      }
    }
    if (missingIn.length) {
      const label = entry.subcommand
        ? `ato ${entry.command} ${entry.subcommand}`
        : `ato ${entry.command}`;
      missingDocs.push({
        id: entry.id,
        command: entry.command,
        subcommand: entry.subcommand,
        source: entry.source,
        missingIn,
        action: `Document ${label} in ${missingIn.join(", ")}.`,
      });
    }
  }

  const removedExports: RemovedExportFinding[] = [];
  const seenRemoved = new Set<string>();
  for (const docPath of requiredDocs) {
    const map = docMaps.get(docPath);
    if (!map) continue;
    for (const [key, refs] of map.entries()) {
      if (exportKeys.has(key) || seenRemoved.has(key)) continue;
      seenRemoved.add(key);
      const { command, subcommand } = splitKey(key);
      removedExports.push({ command, subcommand, docRefs: refs });
    }
  }

  removedExports.sort(
    (a, b) =>
      a.command.localeCompare(b.command) ||
      String(a.subcommand ?? "").localeCompare(String(b.subcommand ?? "")),
  );

  return {
    exports,
    missingDocs,
    removedExports,
    docs: {
      required: requiredDocs,
      optional: optionalDocs,
    },
    summary: {
      totalExports: exports.length,
      missingDocs: missingDocs.length,
      removedExports: removedExports.length,
    },
  };
};
