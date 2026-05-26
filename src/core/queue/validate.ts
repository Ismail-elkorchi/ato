import { promises as fs } from "node:fs";
import path from "node:path";
import { createAjv } from "../schemas/ajv.js";

import { readJson } from "../fs.js";
import {
  resolveAliasMatches,
  resolveSectionFromIndex,
  toContractDocKey,
} from "../contracts/index.js";
import {
  ALLOWED_STATUSES,
  ALLOWED_TYPES,
  ALLOWED_PRIORITIES,
  computeCoreHash,
  isIsoDate,
} from "./transitions.js";
import {
  hasAbsoluteInputCitationPath,
  INPUT_CITATION_PREFIX_MESSAGE,
  isInputCitation,
  parseInputCitation,
} from "./citations.js";
import type {
  AtoConfig,
  ContractRef,
  JsonObject,
  QueueItem,
  QueueSpec,
} from "../types.js";

const PLACEHOLDER_PATTERN = /\b(tbd|todo|fill\s*me)\b/i;
const INPUT_GLOB_PATTERN = /[*?[\]{}]/;
const INPUT_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const INPUT_EVIDENCE_GUIDANCE = [
  "file: inputs must be concrete file paths; globs are not allowed.",
  "Replace globs with concrete file paths (e.g., file:docs/USER_GUIDE.md).",
];
const INPUT_EVIDENCE_EXAMPLE = "file:docs/USER_GUIDE.md";
const INPUT_CITATION_GUIDANCE = [
  `spec.inputs entries must start with ${INPUT_CITATION_PREFIX_MESSAGE}.`,
  "Convert plain paths to file:<repo-relative-path> before validation.",
];
const INPUT_CITATION_EXAMPLE = "file:docs/USER_GUIDE.md";
const INPUT_PATH_GUIDANCE = [
  "spec.inputs path-bearing citations (file:, log:, output:) must be repo-relative.",
  "Use symbolic output/log tokens or repo-relative file: paths instead of absolute paths.",
];

const decodePointerSegment = (value: string): string =>
  value.replace(/~1/g, "/").replace(/~0/g, "~");

const resolveSchemaPointer = (
  schema: JsonObject,
  pointer: string,
): JsonObject | null => {
  if (!pointer || pointer === "#") return schema;
  const normalized = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  const trimmed = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  if (!trimmed) return schema;
  const parts = trimmed.split("/").map(decodePointerSegment);
  let current: JsonObject | null = schema;
  for (const part of parts) {
    if (!current || typeof current !== "object") return null;
    const next: unknown = (current as Record<string, unknown>)[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return null;
    }
    current = next as JsonObject;
  }
  return current;
};

const getAllowedKeys = (schema: JsonObject, schemaPath: string): string[] => {
  const basePointer = schemaPath.replace(/\/additionalProperties$/, "");
  const node = resolveSchemaPointer(schema, basePointer);
  const properties =
    node && typeof node === "object" && !Array.isArray(node)
      ? (node as Record<string, unknown>)["properties"]
      : null;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).sort((a, b) =>
    a.localeCompare(b),
  );
};

const formatAllowedKeys = (allowed: string[]): string => {
  const limit = 20;
  if (allowed.length <= limit) return allowed.join(", ");
  const head = allowed.slice(0, limit).join(", ");
  return `${head} ... (+${allowed.length - limit} more)`;
};

const collectSpecStrings = (spec: QueueSpec | null): string[] => {
  if (!spec || typeof spec !== "object") return [];
  return [
    spec.problem,
    spec.outcome,
    spec.plan?.rationale,
    ...(spec.plan?.steps ?? []),
    ...(spec.acceptance_criteria ?? []),
    ...(spec.inputs ?? []),
    ...(spec.deliverables ?? []),
    ...(spec.scope ?? []),
    ...(spec.risks ?? []),
    ...(spec.runbook ?? []),
  ]
    .map((entry) => (typeof entry === "string" ? entry : ""))
    .filter(Boolean);
};

const hasPlaceholder = (value: string): boolean =>
  typeof value === "string" && PLACEHOLDER_PATTERN.test(value);

const itemHasPlaceholder = (item: QueueItem): boolean => {
  const strings = [item.title, ...(collectSpecStrings(item.spec) ?? [])];
  return strings.some(hasPlaceholder);
};

const resolveInputPath = (
  root: string,
  raw: string,
): { entry: string; resolved: string | null; isFile: boolean; pathPortion: string } => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { entry: trimmed, resolved: null, isFile: false, pathPortion: "" };
  }
  const parsed = parseInputCitation(trimmed);
  if (!parsed) {
    return { entry: trimmed, resolved: null, isFile: false, pathPortion: "" };
  }
  if (parsed.prefix !== "file") {
    return { entry: trimmed, resolved: null, isFile: false, pathPortion: "" };
  }
  const remainder = parsed.remainder;
  const resolved = path.isAbsolute(remainder)
    ? remainder
    : path.resolve(root, remainder);
  return { entry: trimmed, resolved, isFile: true, pathPortion: remainder };
};

export const validateQueueItems = async ({
  items,
  schema,
  config,
  root,
  store,
}: {
  items: QueueItem[];
  schema: JsonObject;
  config: AtoConfig;
  root: string;
  store: string;
}): Promise<{
  errors: Array<{
    id: string;
    message: string;
    details?: {
      instance_path?: string;
      schema_path?: string;
      keyword?: string;
      unexpected_key?: string;
      allowed_keys?: string[];
      guidance?: string[];
      example?: string;
    };
  }>;
  contractError: boolean;
}> => {
  const ajv = createAjv();
  ajv.addFormat("date-time", isIsoDate);
  const validate = ajv.compile(schema);
  const errors: Array<{
    id: string;
    message: string;
    details?: {
      instance_path?: string;
      schema_path?: string;
      keyword?: string;
      unexpected_key?: string;
      allowed_keys?: string[];
      guidance?: string[];
      example?: string;
    };
  }> = [];
  let contractError = false;
  const ids = new Set(items.map((item) => item.id));
  const idCounts = new Map();

  for (const item of items) {
    const count = (idCounts.get(item.id) ?? 0) + 1;
    idCounts.set(item.id, count);
    if (count > 1) {
      errors.push({ id: item.id, message: "Duplicate ID." });
    }

    const ok = validate(item);
    if (!ok) {
      for (const error of validate.errors ?? []) {
        const instancePath = error.instancePath || "/";
        const schemaPath = error.schemaPath || "";
        const details: {
          instance_path?: string;
          schema_path?: string;
          keyword?: string;
          unexpected_key?: string;
          allowed_keys?: string[];
        } = {
          instance_path: instancePath,
          schema_path: schemaPath,
        };
        if (typeof error.keyword === "string") {
          details.keyword = error.keyword;
        }
        let suffix = schemaPath ? ` (schema: ${schemaPath})` : "";
        if (error.keyword === "additionalProperties") {
          const params = error.params ?? {};
          const unexpected = params["additionalProperty"];
          if (typeof unexpected === "string") {
            details.unexpected_key = unexpected;
            suffix += ` (unexpected: ${unexpected})`;
          }
          const allowed = getAllowedKeys(schema, schemaPath);
          if (allowed.length) {
            details.allowed_keys = allowed;
            suffix += ` (allowed: ${formatAllowedKeys(allowed)})`;
          }
        }
        errors.push({
          id: item.id,
          message: `${instancePath} ${error.message ?? "schema error"}${suffix}`,
          details,
        });
      }
    }

    if (!ALLOWED_STATUSES.has(item.status)) {
      errors.push({ id: item.id, message: `Invalid status ${item.status}.` });
    }

    if (!ALLOWED_TYPES.has(item.type)) {
      errors.push({ id: item.id, message: `Invalid type ${item.type}.` });
    }

    const priorityValue = item.priority;
    const isNumericPriority =
      typeof priorityValue === "number" &&
      Number.isInteger(priorityValue) &&
      priorityValue >= 0 &&
      priorityValue <= 4;
    if (
      !isNumericPriority &&
      !ALLOWED_PRIORITIES.has(String(priorityValue))
    ) {
      errors.push({
        id: item.id,
        message: `Invalid priority ${item.priority}.`,
      });
    }

    if (item.created_at && !isIsoDate(item.created_at)) {
      errors.push({ id: item.id, message: "created_at must be ISO date." });
    }

    if (item.updated_at && !isIsoDate(item.updated_at)) {
      errors.push({ id: item.id, message: "updated_at must be ISO date." });
    }

    if (
      ["queued", "active"].includes(item.status) &&
      itemHasPlaceholder(item)
    ) {
      errors.push({
        id: item.id,
        message: "Queued/active items cannot contain placeholder strings.",
      });
    }

    if (["queued", "active"].includes(item.status)) {
      const inputs = Array.isArray(item.spec?.inputs) ? item.spec.inputs : [];
      for (let index = 0; index < inputs.length; index += 1) {
        const entry = inputs[index];
        const value = String(entry ?? "").trim();
        if (!value) continue;
        const pointer = `/spec/inputs/${index}`;
        if (!isInputCitation(value)) {
          errors.push({
            id: item.id,
            message:
              `${pointer} inputs must include an evidence citation ` +
              `(${INPUT_CITATION_PREFIX_MESSAGE}): ${value}`,
            details: {
              instance_path: pointer,
              guidance: INPUT_CITATION_GUIDANCE,
              example: INPUT_CITATION_EXAMPLE,
            },
          });
          continue;
        }
        if (hasAbsoluteInputCitationPath(value)) {
          errors.push({
            id: item.id,
            message:
              `${pointer} citation path must be repo-relative; absolute paths are not allowed: ${value}`,
            details: {
              instance_path: pointer,
              guidance: INPUT_PATH_GUIDANCE,
              example: INPUT_CITATION_EXAMPLE,
            },
          });
          continue;
        }
        const { entry: rawEntry, resolved, isFile, pathPortion } =
          resolveInputPath(root, value);
        if (!isFile) continue;
        const details = {
          instance_path: pointer,
          guidance: INPUT_EVIDENCE_GUIDANCE,
          example: INPUT_EVIDENCE_EXAMPLE,
        };
        if (INPUT_GLOB_PATTERN.test(pathPortion)) {
          errors.push({
            id: item.id,
            message:
              `${pointer} file: inputs must be a concrete file path; ` +
              `globs are not allowed: ${rawEntry}`,
            details,
          });
          continue;
        }
        if (path.isAbsolute(pathPortion) || INPUT_ABSOLUTE_PATTERN.test(pathPortion)) {
          errors.push({
            id: item.id,
            message:
              `${pointer} file: inputs must be repo-relative; ` +
              `absolute paths are not allowed: ${rawEntry}`,
            details,
          });
          continue;
        }
        if (!resolved) continue;
        try {
          const stats = await fs.stat(resolved);
          if (stats.isDirectory()) {
            errors.push({
              id: item.id,
              message:
                `${pointer} file: inputs must reference a file, ` +
                `not a directory: ${rawEntry}`,
              details,
            });
            continue;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code && code !== "ENOENT") {
            errors.push({
              id: item.id,
              message: `${pointer} file: inputs could not be read: ${rawEntry} (${code})`,
              details,
            });
          }
        }
      }
      const contractRefs = item.spec?.contract_refs ?? [];
      if (!contractRefs.length) {
        errors.push({
          id: item.id,
          message: "Queued/active items must include spec.contract_refs.",
        });
        contractError = true;
      }
    }

    const selector = item.target?.selector ?? item.target?.kind ?? "unbounded";
    if (
      ["queued", "active", "blocked"].includes(item.status) &&
      selector === "unbounded"
    ) {
      errors.push({
        id: item.id,
        message: "Open items must target exact/range/milestone.",
      });
    }

    const tagMismatch = (item.tags ?? []).find(
      (tag) => tag !== tag.toLowerCase(),
    );
    if (tagMismatch) {
      errors.push({
        id: item.id,
        message: `Tag '${tagMismatch}' must be lowercase.`,
      });
    }

    if (item.status === "done") {
      if (!item.frozen?.core_hash) {
        errors.push({
          id: item.id,
          message: "Done items must include frozen.core_hash.",
        });
      } else if (item.frozen.core_hash !== computeCoreHash(item)) {
        errors.push({ id: item.id, message: "frozen.core_hash mismatch." });
      }
    }

    const deps = item.deps ?? [];
    for (const dep of deps) {
      if (!ids.has(dep)) {
        errors.push({
          id: item.id,
          message: `Dependency ${dep} does not exist.`,
        });
      }
    }

    const openNeeds = (item.details?.needs ?? []).some(
      (need) => need.status === "open",
    );
    if (openNeeds && item.status !== "blocked") {
      errors.push({
        id: item.id,
        message: "Items with open needs must be blocked.",
      });
    }

    const tags = item.tags ?? [];
    const macro = tags.includes("macro-scope") || tags.includes("contract");
    if (macro) {
      const spec = item.spec ?? {};
      const details = item.details ?? {};
      if (!spec.contract_refs?.length) {
        errors.push({
          id: item.id,
          message: "Macro-scope item missing spec.contract_refs.",
        });
        contractError = true;
      }
      if (!spec.acceptance_criteria?.length) {
        errors.push({
          id: item.id,
          message: "Macro-scope item missing acceptance criteria.",
        });
      }
      if (!spec.risks?.length) {
        errors.push({
          id: item.id,
          message: "Macro-scope item missing risks.",
        });
      }
      if (!details.effort) {
        errors.push({
          id: item.id,
          message: "Macro-scope item missing effort.",
        });
      }
    }
  }

  const contractRefs: Array<{ item: QueueItem; ref: ContractRef }> =
    items.flatMap((item) =>
      (item.spec?.contract_refs ?? []).map((ref) => ({ item, ref })),
    );
  if (contractRefs.length) {
    const indexPath = path.join(store, "cache", "contracts.index.json");
    const index = await readJson(indexPath, null);
    if (!index) {
      errors.push({ id: "contract_refs", message: "Missing contract index." });
      contractError = true;
      return { errors, contractError };
    }
    for (const { item, ref } of contractRefs) {
      const contracts = config.contracts;
      const platformDoc =
        contracts && typeof contracts === "object" && !Array.isArray(contracts)
          ? contracts.platform
          : null;
      const arrayDoc = Array.isArray(contracts) ? contracts[0] : null;
      const contractDoc =
        typeof contracts === "string"
          ? contracts
          : platformDoc ?? arrayDoc;
      const resolved =
        typeof ref === "string"
          ? {
              doc: contractDoc,
              section: ref,
            }
          : ref;
      if (!resolved?.doc) {
        errors.push({
          id: item.id,
          message: "Missing contract doc path for contract refs.",
        });
        contractError = true;
        continue;
      }
      const docKey = toContractDocKey(root, resolved.doc);
      let entry = resolveSectionFromIndex({
        index,
        doc: docKey,
        section: resolved.section,
      });
      const alias = typeof ref === "string" ? ref : (resolved.section ?? "").trim();
      const aliasMatches = alias
        ? resolveAliasMatches({
            index,
            alias,
            doc: typeof ref === "string" ? null : resolved.doc,
          })
        : [];
      if (alias && typeof ref === "string" && aliasMatches.length > 1) {
        const candidates = aliasMatches
          .map((match) => {
            const section =
              match.entry.sectionNumber ??
              match.entry.anchor ??
              match.entry.heading;
            return {
              doc: match.doc,
              section: section ?? "",
            };
          })
          .sort((a, b) => {
            if (a.doc !== b.doc) return a.doc.localeCompare(b.doc);
            return a.section.localeCompare(b.section);
          })
          .map((candidate) => `${candidate.doc}::${candidate.section}`)
          .join(", ");
        errors.push({
          id: item.id,
          message:
            `Ambiguous contract ref alias ${alias}. ` +
            `Candidates: ${candidates}. ` +
            'Use spec.contract_refs like [{"doc":"<doc-path>","section":"6.1"}].',
        });
        contractError = true;
        continue;
      }
      if (!entry && alias) {
        if (aliasMatches.length === 1) {
          entry = aliasMatches[0]?.entry ?? null;
        } else if (aliasMatches.length > 1) {
          const candidates = aliasMatches
            .map((match) => {
              const section =
                match.entry.sectionNumber ??
                match.entry.anchor ??
                match.entry.heading;
              return {
                doc: match.doc,
                section: section ?? "",
              };
            })
            .sort((a, b) => {
              if (a.doc !== b.doc) return a.doc.localeCompare(b.doc);
              return a.section.localeCompare(b.section);
            })
            .map((candidate) => `${candidate.doc}::${candidate.section}`)
            .join(", ");
          errors.push({
            id: item.id,
            message:
              `Ambiguous contract ref alias ${alias}. ` +
              `Candidates: ${candidates}. ` +
              'Use spec.contract_refs like [{"doc":"<doc-path>","section":"6.1"}].',
          });
          contractError = true;
          continue;
        }
      }
      if (!entry) {
        errors.push({
          id: item.id,
          message:
            `Unresolved contract ref ${resolved.section}. ` +
            'Use spec.contract_refs like [{"doc":"<doc-path>","section":"6.1"}] ' +
            'and run "ato contract index" to list sections.',
        });
        contractError = true;
      }
    }
  }
  return { errors, contractError };
};
