import path from "node:path";
import { promises as fs } from "node:fs";

import {
  parseFlags,
  writeJson,
  writeLines,
  formatTargetLine,
} from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { readJsonl, readJson, ensureDir } from "../../core/fs.js";
import { readQueueItems } from "../../core/queue/store.js";
import { selectNextItems } from "../../core/queue/ordering.js";
import { validateQueueItems } from "../../core/queue/validate.js";
import { extractSection } from "../../core/contracts/extract.js";
import {
  resolveAliasMatches,
  resolveSectionFromIndex,
  toContractDocKey,
} from "../../core/contracts/index.js";
import { readState, writeState } from "../../core/state.js";
import { buildBlackboardView } from "../../core/blackboard/view.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { buildPack } from "../../core/pack/generator.js";
import { verifyCycleEvidencePack } from "../../core/eval/pack.js";
import type { CommandContext } from "../types.js";
import type {
  BlackboardSignal,
  ContractRef,
  JsonObject,
  LessonItem,
  PatternItem,
  QueueItem,
  RunLogEntry,
  TargetContext,
} from "../../core/types.js";
import type { ContractEntry, ContractIndex } from "../../core/contracts/index.js";

type RouterEntry = {
  path: string;
  scope?: string | null;
  content?: string;
};

type RouteIndex = {
  routers?: RouterEntry[];
};

const HELP = [
  "Usage:",
  "  ato pack --task <text> [options]",
  "  ato pack verify --path <pack> [--json]",
  "",
  "Examples:",
  "  ato pack --task \"Summarize queue\" --budget 2400 --format md",
  "  ato pack verify --path .ato/packs/CY-0001.tar --json",
].join("\n");

const loadQueueSchema = async (): Promise<JsonObject> => {
  const schemaUrl = new URL(
    "../../core/schemas/queue.v2.json",
    import.meta.url,
  );
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw) as JsonObject;
};

const ensureQueueValid = ({
  errors,
  contractError,
}: {
  errors: Array<{ id: string; message: string }>;
  contractError: boolean;
}): void => {
  if (!errors.length) return;
  const error = new Error("Queue validation failed.");
  (error as Error & { code?: number; details?: unknown }).code =
    contractError ? 6 : 3;
  (error as Error & { details?: unknown }).details = { errors };
  throw error;
};

const PATHISH_EXT = /\.[a-z0-9]+$/i;

const isPathLike = (value: unknown): boolean => {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    PATHISH_EXT.test(trimmed)
  );
};

const normalizeCandidatePath = (value: unknown, root: string): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) {
    return path.relative(root, normalized).replace(/\\/g, "/");
  }
  return normalized;
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const deriveCandidatePaths = (
  queueItem: QueueItem | null,
  root: string,
): string[] => {
  if (!queueItem?.spec) return [];
  const scopeEntries = Array.isArray(queueItem.spec.scope)
    ? queueItem.spec.scope
    : [];
  const scopePaths = Array.isArray(queueItem.spec.scope_paths)
    ? queueItem.spec.scope_paths
    : [];
  const raw = [
    ...scopeEntries.filter((entry) => isPathLike(entry)),
    ...scopePaths,
  ];
  const result = new Set<string>();
  for (const entry of raw) {
    const normalized = normalizeCandidatePath(entry, root);
    if (normalized) result.add(normalized);
  }
  return [...result];
};

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
};

const selectScopedRouter = (
  routers: RouterEntry[],
  candidatePaths: string[],
): RouterEntry | null => {
  if (!candidatePaths.length) return null;
  const scoped = routers.filter(
    (router) => router.scope && router.path !== "AGENTS.md",
  );
  let match = null;
  for (const router of scoped) {
    const scope = router.scope ?? "";
    const pattern = globToRegExp(scope);
    for (const candidate of candidatePaths) {
      if (pattern.test(candidate)) {
        if (!match || scope.length > (match.scope ?? "").length) {
          match = router;
        }
      }
    }
  }
  return match;
};

const resolveRouters = async ({
  target,
  candidatePaths,
}: {
  target: TargetContext;
  candidatePaths: string[];
}): Promise<{
  root: { path: string; scope: string | null; content: string };
  scoped: { path: string; scope: string | null; content: string } | null;
}> => {
  const indexPath = path.join(target.storePath, "cache", "routes.index.json");
  const index = await readJson<RouteIndex>(indexPath, null);
  const routers = index?.routers ?? [];
  const rootRouter = routers.find((router) => router.path === "AGENTS.md") ?? {
    path: "AGENTS.md",
  };
  const scopedRouter = selectScopedRouter(routers, candidatePaths);

  const rootPath = path.join(target.root, rootRouter.path ?? "AGENTS.md");
  const rootContent = await fs.readFile(rootPath, "utf8").catch(() => "");

  let scoped = null;
  if (scopedRouter) {
    const scopedContent = await fs
      .readFile(path.join(target.root, scopedRouter.path), "utf8")
      .catch(() => "");
    scoped = {
      path: scopedRouter.path,
      scope: scopedRouter.scope ?? null,
      content: scopedContent,
    };
  }

  return {
    root: {
      path: rootRouter.path ?? "AGENTS.md",
      scope: rootRouter.scope ?? null,
      content: rootContent,
    },
    scoped,
  };
};

const resolveRef = (
  ref: ContractRef,
  config: TargetContext["config"],
): { doc: string; section: string } => {
  if (typeof ref === "string") {
    const contracts = config.contracts;
    const doc =
      typeof contracts === "string"
        ? contracts
        : Array.isArray(contracts)
          ? contracts[0]
          : contracts?.platform;
    return {
      doc: doc ?? "",
      section: ref,
    };
  }
  return ref;
};

export const runPackCommand = async ({
  args,
  context,
}: {
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { flags, positionals } = parseFlags(args);
  const json = context.json;
  const subcommand = positionals[0] ?? null;

  if (subcommand === "verify") {
    if (flags["help"]) {
      writeLines([HELP]);
      return;
    }
    const packPath =
      typeof flags["path"] === "string" ? flags["path"].trim() : "";
    if (!packPath) {
      throw new Error("Missing required --path.");
    }
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const manifestPath =
      typeof flags["manifest"] === "string" ? flags["manifest"].trim() : undefined;
    const verifyInput: {
      root: string;
      packPath: string;
      manifestPath?: string;
    } = {
      root: target.root,
      packPath,
    };
    if (manifestPath) {
      verifyInput.manifestPath = manifestPath;
    }
    const result = await verifyCycleEvidencePack(verifyInput);
    if (json) {
      writeJson(result);
    } else {
      const lines = [
        formatTargetLine(target),
        `verify: ${result.ok ? "ok" : "fail"}`,
        `pack: ${result.pack_path}`,
        `manifest: ${result.manifest_path}`,
        `verified_files: ${result.verified_files_count}`,
      ];
      if (result.missing_required.length) {
        lines.push(`missing_required: ${result.missing_required.length}`);
      }
      if (result.failures.length) {
        lines.push(...result.failures.map((entry) => `- ${entry.message}`));
      }
      writeLines(lines);
    }
    if (!result.ok) {
      process.exitCode = 3;
    }
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    if (typeof flags["task"] !== "string" || !flags["task"].trim()) {
      if (flags["help"]) {
        writeLines([HELP]);
        return;
      }
      throw new Error("Missing required --task.");
    }
    const task = flags["task"].trim();
    const budgetValue =
      typeof flags["budget"] === "string"
        ? flags["budget"]
        : target.config.pack?.defaultBudget ?? 2400;
    const budget = Number(budgetValue);
    const format =
      typeof flags["format"] === "string" ? flags["format"] : "md";
    const focus = typeof flags["focus"] === "string" ? flags["focus"] : null;
    const withCitations =
      flags["with-citations"] === true || flags["with-citations"] === "true";
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("Invalid --budget. Provide a positive number.");
    }
    if (!["md", "json"].includes(format)) {
      throw new Error(`Invalid --format '${format}'. Use 'md' or 'json'.`);
    }
    const packFormat = format as "md" | "json";

    const records = await readQueueItems(target.storePath);
    const items = records.map((record) => record.item);
    const schema = await loadQueueSchema();
    const validation = await validateQueueItems({
      items,
      schema,
      config: target.config,
      root: target.root,
      store: target.storePath,
    });
    ensureQueueValid(validation);

    let queueItem: QueueItem | null = null;
    if (typeof flags["queue"] === "string") {
      queueItem = items.find((item) => item.id === flags["queue"]) ?? null;
    } else {
      const state = await readState(target.storePath);
      if (state.activeQueueId) {
        queueItem =
          items.find((item) => item.id === state.activeQueueId) ?? null;
      }
      if (!queueItem) {
        const selection = selectNextItems({
          items: records,
          target: null,
          focus: null,
          limit: 1,
        });
        queueItem = selection.selected[0]?.item ?? null;
      }
    }

    const queueRecord = queueItem
      ? records.find((record) => record.item.id === queueItem?.id) ?? null
      : null;
    const queuePath = toPosixPath(
      path.relative(target.root, path.join(target.storePath, "queue", "items.jsonl")),
    );
    const queueLine = queueRecord?.line ?? null;

    const candidatePaths = deriveCandidatePaths(queueItem, target.root);
    const routers = await resolveRouters({ target, candidatePaths });

    const contractSections: Array<{
      entry: ContractEntry;
      content: string;
      docPath: string;
    }> = [];
    const contractRefs = queueItem?.spec?.contract_refs ?? [];

    if (contractRefs.length) {
      const indexPath = path.join(
        target.storePath,
        "cache",
        "contracts.index.json",
      );
      const index = await readJson<ContractIndex>(indexPath, null);
      if (!index) {
        const error = new Error(
          "Missing contract index. Run `ato contract index` first.",
        );
        (error as Error & { code?: number }).code = 6;
        throw error;
      }

      for (const ref of contractRefs) {
        let resolvedRef = resolveRef(ref, target.config);
        let docPath = path.resolve(target.root, resolvedRef.doc);
        let docKey = toContractDocKey(target.root, resolvedRef.doc);
        let entry = resolveSectionFromIndex({
          index,
          doc: docKey,
          section: resolvedRef.section,
        });
        if (!entry) {
          const alias = typeof ref === "string" ? ref : resolvedRef.section;
          const aliasMatches = resolveAliasMatches({
            index,
            alias,
            doc: typeof ref === "string" ? null : resolvedRef.doc,
          });
          if (aliasMatches.length === 1) {
            const match = aliasMatches[0];
            if (match) {
              const section =
                match.entry.sectionNumber ??
                match.entry.anchor ??
                match.entry.heading;
              resolvedRef = { doc: match.doc, section };
              docPath = path.resolve(target.root, match.doc);
              docKey = match.doc;
              entry = match.entry;
            }
          } else if (aliasMatches.length > 1) {
            const candidates = aliasMatches
              .map((match) => {
                const section =
                  match.entry.sectionNumber ??
                  match.entry.anchor ??
                  match.entry.heading;
                return `${match.doc}::${section}`;
              })
              .join(", ");
            const error = new Error(
              `Ambiguous contract ref alias '${alias}'. Candidates: ${candidates}.`,
            );
            (error as Error & { code?: number }).code = 6;
            throw error;
          }
        }
        if (!entry) {
          const error = new Error(
            `Unable to resolve contract section '${resolvedRef.section}'.`,
          );
          (error as Error & { code?: number }).code = 6;
          throw error;
        }
        const extracted = await extractSection({
          index,
          doc: docPath,
          section: resolvedRef.section,
          docKey,
        });
        if (extracted) {
          contractSections.push({
            ...extracted,
            docPath: toPosixPath(path.relative(target.root, docPath)),
          });
        }
      }
    }

    const lessonsPath = path.join(target.storePath, "lessons", "items.jsonl");
    const patternsPath = path.join(target.storePath, "patterns", "items.jsonl");
    const lessonsRecords = await readJsonl<LessonItem>(lessonsPath);
    const patternsRecords = await readJsonl<PatternItem>(patternsPath);
    const runRecords = await readJsonl<RunLogEntry>(
      path.join(target.storePath, "runs", "runs.jsonl"),
    );
    const cycleState = await readState(target.storePath);
    const observations = target.config.blackboard?.observations ?? [];
    let signals: BlackboardSignal[] = [];
    try {
      const blackboardView = await buildBlackboardView({
        root: target.root,
        store: target.storePath,
        observations,
        cycleId: cycleState.activeCycleId ?? null,
        deterministic: true,
        readOnly: true,
      });
      signals = blackboardView.signals ?? [];
    } catch (error) {
      const err = error as Error & { code?: number };
      if (err.code !== 3) {
        throw error;
      }
      signals = [];
    }

    const lessons = lessonsRecords.map((record) => record.item);
    const patterns = patternsRecords.map((record) => record.item);
    const lessonLineMap: Record<string, number> = {};
    for (const record of lessonsRecords) {
      if (record.item?.id) {
        lessonLineMap[record.item.id] = record.line;
      }
    }
    const patternLineMap: Record<string, number> = {};
    for (const record of patternsRecords) {
      if (record.item?.id) {
        patternLineMap[record.item.id] = record.line;
      }
    }
    const runLogEntries = runRecords.map((record) => record.item);

    const lessonSourcePath = toPosixPath(path.relative(target.root, lessonsPath));
    const patternSourcePath = toPosixPath(
      path.relative(target.root, patternsPath),
    );

    const pack = buildPack({
      task,
      focus,
      budget,
      format: packFormat,
      queueItem,
      queueLine,
      queuePath,
      routers,
      contractSections,
      blackboardSignals: signals,
      lessons,
      lessonLineMap,
      lessonSourcePath,
      patterns,
      patternLineMap,
      patternSourcePath,
      runLogEntries,
      withCitations,
    });

    const artifactDir = getArtifactsDir(
      target.storePath,
      queueItem?.id ?? null,
      "pack",
    );
    await ensureDir(artifactDir);
    const artifactPath = path.join(
      artifactDir,
      `pack-${Date.now()}.${packFormat === "json" ? "json" : "md"}`,
    );
    await fs.writeFile(artifactPath, pack.output, "utf8");

    const runLogEntry: RunLogEntry = {
      ts: new Date().toISOString(),
      kind: "pack",
      target_id: target.id,
      commands: [],
      artifacts: [artifactPath],
      summary: `pack ${packFormat}${pack.overBudget ? " (over budget)" : ""}`,
    };
    if (queueItem?.id) {
      runLogEntry.queue_id = queueItem.id;
    }
    await appendRunLog(target.storePath, runLogEntry);

    const state = await readState(target.storePath);
    const nextState = {
      ...state,
      version: state.version ?? 1,
      targetId: target.id,
      lastPack: {
        tokens: pack.tokens ?? null,
        bytes: pack.output.length,
        budget,
        ts: new Date().toISOString(),
      },
    };
    await writeState(target.storePath, nextState);

    if (json) {
      writeJson({
        ok: true,
        output: pack.output,
        artifact: artifactPath,
        tokens: pack.tokens ?? null,
        overBudget: pack.overBudget,
        requiredTokens: pack.requiredTokens ?? null,
        gaps: pack.gaps ?? [],
        budget,
      });
    } else {
      writeLines([formatTargetLine(target), pack.output.trimEnd()]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
