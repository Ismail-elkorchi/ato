import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  parseFlags,
  writeJson,
  writeLines,
  formatTargetLine,
} from "../utils.js";
import { parseJsonInput } from "./input.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
  ensureCrossStoreWriteAllowed,
} from "./shared.js";
import { resolveTarget } from "../../core/targets/resolve.js";
import {
  readQueueItems,
  writeQueueItems,
  nextQueueId,
  getQueuePaths,
} from "../../core/queue/store.js";
import { buildIntakeItem } from "../../core/queue/intake.js";
import {
  selectNextItems,
  priorityRank,
  statusRank,
  targetSpecificity,
} from "../../core/queue/ordering.js";
import {
  ALLOWED_TYPES,
  ALLOWED_PRIORITIES,
  ALLOWED_STATUSES,
  normalizeTags,
  normalizeEvidence,
  normalizeDeps,
  parseTargetInput,
  formatTarget,
} from "../../core/queue/transitions.js";
import { appendRunLog } from "../../core/runlog.js";
import {
  readJson as readJsonFile,
  stableStringify,
} from "../../core/fs.js";
import { validateQueueItems } from "../../core/queue/validate.js";
import {
  INPUT_CITATION_HELP_PATTERN,
  INPUT_CITATION_PREFIX_MESSAGE,
  isInputCitation,
} from "../../core/queue/citations.js";
import {
  resolveDocPath,
  resolveSectionFromIndex,
  toContractDocKey,
} from "../../core/contracts/index.js";
import type { ContractIndex } from "../../core/contracts/index.js";
import type { CommandContext } from "../types.js";
import type {
  ContractRef,
  JsonObject,
  QueueItem,
  QueueOrigin,
  QueueNeed,
  QueuePriority,
  QueueSpec,
  QueueTarget,
  TargetContext,
} from "../../core/types.js";

type PlainObject = Record<string, unknown>;
const QUEUE_LIST_SCHEMA_VERSION = "queue-list.v1";
const QUEUE_VALIDATE_SCHEMA_VERSION = "queue-validate.v1";

const loadQueueSchema = async (): Promise<JsonObject> => {
  const schemaUrl = new URL(
    "../../core/schemas/queue.v2.json",
    import.meta.url,
  );
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw) as JsonObject;
};

const readJsonFileStrict = async (filePath: string): Promise<unknown> => {
  const resolved = path.resolve(process.cwd(), filePath);
  try {
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    throw new Error(`Unable to read --file ${filePath}: ${message}`);
  }
};

const sortItems = (items: QueueItem[]): QueueItem[] =>
  [...items].sort((a, b) => {
    const targetDiff =
      targetSpecificity(a.target) - targetSpecificity(b.target);
    if (targetDiff !== 0) return targetDiff;
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const createdDiff = String(a.created_at).localeCompare(
      String(b.created_at),
    );
    if (createdDiff !== 0) return createdDiff;
    return String(a.id).localeCompare(String(b.id));
  });

const HEADER = (note: string): string =>
  [
    "<!-- GENERATED FILE: do not edit by hand. -->",
    `<!-- ${note} -->`,
    "",
  ].join("\n");

const TRANSFER_DEFAULT_STATUSES = ["queued", "active"] as const;

const requireFlagValue = (flag: string, value: string | undefined): string => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("--")) {
    throw new Error(`Missing value for --${flag}.`);
  }
  return trimmed;
};

const collectFlagValues = (args: string[], name: string): string[] => {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== `--${name}`) continue;
    const next = args[i + 1];
    values.push(requireFlagValue(name, next));
    i += 1;
  }
  return values;
};

const hasGitDir = (repoRoot: string): boolean =>
  existsSync(path.join(repoRoot, ".git"));

const readGitHead = (repoRoot: string): string | null => {
  if (!hasGitDir(repoRoot)) return null;
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const head = String(result.stdout ?? "").trim();
  return head || null;
};

const readGitRemote = (repoRoot: string): string | null => {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const remote = String(result.stdout ?? "").trim();
  return remote || null;
};

const resolveOriginSubpath = (repoRoot: string, cwd: string | null): string | null => {
  if (!cwd) return null;
  const relative = path.relative(repoRoot, path.resolve(cwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
};

const buildOrigin = ({
  repoRoot,
  cwd,
}: {
  repoRoot: string;
  cwd: string | null;
}): QueueOrigin | null => {
  const commit = readGitHead(repoRoot);
  if (!commit) return null;
  const repoRemote = readGitRemote(repoRoot);
  const origin: QueueOrigin = { commit };
  if (repoRemote) {
    origin.repo_remote = repoRemote;
  } else {
    origin.repo_path = repoRoot;
  }
  const subpath = resolveOriginSubpath(repoRoot, cwd);
  if (subpath) origin.subpath = subpath;
  return origin;
};

const resolveProducerTarget = async (
  cwd: string,
): Promise<TargetContext | null> => {
  try {
    const { target } = await resolveTarget({
      cwd,
      selection: null,
      storeSelection: process.env["ATO_STORE"] ?? null,
      requireWrite: false,
    });
    return target;
  } catch {
    return null;
  }
};

const resolveCrossRepoOrigin = async (
  target: TargetContext,
): Promise<QueueOrigin | null> => {
  const sourceTarget = await resolveProducerTarget(process.cwd());
  if (!sourceTarget) return null;
  const sourceRoot = path.resolve(sourceTarget.root);
  const targetRoot = path.resolve(target.root);
  if (sourceRoot === targetRoot) return null;
  return buildOrigin({ repoRoot: sourceRoot, cwd: process.cwd() });
};

const applyOriginIfMissing = (
  item: QueueItem,
  origin: QueueOrigin | null,
): QueueItem => {
  if (!origin || item.origin) return item;
  return { ...item, origin };
};

const buildTraceOrigin = (origin: QueueOrigin | undefined) => ({
  repo_remote: origin?.repo_remote ?? null,
  repo_path: origin?.repo_path ?? null,
  commit: origin?.commit ?? null,
  subpath: origin?.subpath ?? null,
  created_by: origin?.created_by ?? null,
});

const buildTraceSuggestions = (origin: ReturnType<typeof buildTraceOrigin>) => {
  const commands: string[] = [];
  if (origin.repo_path) {
    commands.push(`ATO_REPO="${origin.repo_path}"`);
  }
  if (origin.commit) {
    commands.push(`git show ${origin.commit}`);
    commands.push(`git checkout ${origin.commit}`);
    if (origin.repo_remote) {
      let clone = `git clone ${origin.repo_remote} repo && cd repo && git checkout ${origin.commit}`;
      if (origin.subpath) {
        clone += ` && cd ${origin.subpath}`;
      }
      commands.push(clone);
    }
  } else if (origin.repo_remote) {
    commands.push(`git clone ${origin.repo_remote} repo`);
  }
  return commands;
};

const parseStatusFilter = (
  raw: string | boolean | undefined,
): QueueItem["status"][] => {
  if (raw === true) {
    throw new Error("Missing value for --status.");
  }
  if (typeof raw !== "string") {
    return [...TRANSFER_DEFAULT_STATUSES];
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) {
    throw new Error("Missing values for --status.");
  }
  const normalized: QueueItem["status"][] = [];
  for (const entry of entries) {
    if (!ALLOWED_STATUSES.has(entry)) {
      throw new Error(`Invalid --status '${entry}'.`);
    }
    if (!normalized.includes(entry as QueueItem["status"])) {
      normalized.push(entry as QueueItem["status"]);
    }
  }
  return normalized;
};

const QUEUE_HELP: Record<string, string[]> = {
  root: [
    "Usage: ato q <subcommand> [options]",
    "",
    "Subcommands:",
    "  add|update|validate|view|list|trace|intake|transfer|contract-refs",
    "",
    "Run: ato q <subcommand> --help",
  ],
  add: [
    "Usage: ato q add \"TITLE\" [options]",
    "",
    "Required flags:",
    "  --problem <text>",
    "  --outcome <text>",
    "  --plan-steps \"S1|S2\"",
    "  --acceptance \"A|B|C\"",
    "  --inputs \"I1|I2\"",
    "  --deliverables \"D1|D2\"",
    "",
    "Options:",
    "  --type <bug|debt|waiver|quality-debt|feature|doc|contract|tooling|investigation>",
    "  --queue-target <exact|range|milestone>",
    "  --priority <P0..P4|0..4>",
    "  --scope \"S1|S2\"",
    "  --risks \"R1|R2\"",
    "  --plan-rationale <text>",
    "  --runbook \"cmd1|cmd2\"",
    "  --contract-refs '[{\"doc\":\"...\",\"section\":\"6.1\"}]'",
    "  --contractRefs '[{\"doc\":\"...\",\"section\":\"6.1\"}]'",
    "",
    "Example:",
    "  ato q add \"Ship dashboard\" --type feature --queue-target range:0.1.x --priority P1 --problem \"...\" --outcome \"...\" --plan-steps \"S1|S2\" --acceptance \"A|B\" --inputs \"I1\" --deliverables \"D1\"",
  ],
  update: [
    "Usage: ato q update <id> [options]",
    "",
    "Options:",
    "  --input <json|path>  JSON patch object or file path",
    "  --priority <P0..P4|0..4>",
    "  --status <queued|blocked|dropped>",
    "  --queue-target <exact|range|milestone>",
    "  --add-tag <tag> (repeatable)",
    "  --remove-tag <tag> (repeatable)",
    "  --note <text> (repeatable)",
    "  --outcome <text>",
    "  --plan-steps \"S1|S2\"",
    "  --plan-rationale <text>",
    "  --acceptance-add <check> (repeatable)",
    "  --acceptance-set @<file.json> (replace)",
    `  --evidence-add <${INPUT_CITATION_HELP_PATTERN}> (repeatable)`,
    "",
    "Example:",
    "  ato q update BL-0004 --priority P1 --status blocked --add-tag cli --note \"Waiting\"",
  ],
  intake: [
    "Usage: ato q intake --file <candidate.json> [options]",
    "",
    "Options:",
    "  --file <path>           JSON candidate file (proposal or full item)",
    "  --dest <path|id>        Destination store for intake (optional)",
    "  --allow-cross-store-write  Allow cross-store writes when --dest points elsewhere",
    "  --dry-run               Validate only; do not write to queue",
    "  --telemetry-ref <ref>   Optional telemetry snapshot ref to record",
    "",
    "Example:",
    "  ato q intake --file /tmp/candidate.json --dest /path/to/dest --allow-cross-store-write --json",
  ],
  transfer: [
    "Usage: ato q transfer <id> [options]",
    "",
    "Options:",
    "  --dest <path|id>     Destination store (required)",
    "  --allow-cross-store-write  Allow cross-store writes to destination",
    "  --source <path|id>   Source repo (default: cwd)",
    "  --all                Transfer queued/active items in batch",
    "  --status <list>      Status filter (default: queued,active)",
    "  --dry-run            Validate only; do not write to destination",
    "",
    "Example:",
    "  ato q transfer BL-0001 --dest /path/to/dest --source /path/to/source --allow-cross-store-write --json",
  ],
  validate: [
    "Usage: ato q validate",
    "",
    "Example:",
    "  ato q validate",
  ],
  view: [
    "Usage: ato q view",
    "",
    "Options:",
    "  --quiet   Suppress item output (views only)",
    "",
    "Example:",
    "  ato q view",
  ],
  list: [
    "Usage: ato q list [options]",
    "",
    "Options:",
    "  --status <queued|active|blocked|done|dropped>",
    "  --tag <tag1,tag2>     Filter by tags (requires all)",
    "  --queue-target <target>  Filter by target (exact|range|milestone)",
    "  --owner <owner>       Filter by owner",
    "  --json                Emit JSON output",
    "",
    "Example:",
    "  ato q list --status queued --tag cli",
  ],
  trace: [
    "Usage: ato q trace <id>",
    "",
    "Options:",
    "  --json  Emit JSON output",
    "",
    "Example:",
    "  ato q trace BL-0001 --json",
  ],
  "contract-refs": [
    "Usage: ato q contract-refs <action> [options]",
    "",
    "Actions:",
    "  fix",
    "",
    "Run: ato q contract-refs fix --help",
  ],
  "contract-refs fix": [
    "Usage: ato q contract-refs fix --ids <id,...> --dest <dest> [--apply] [--json]",
    "",
    "Options:",
    "  --ids <id,...>   Comma-delimited queue ids to inspect/fix.",
    "  --dest <dest>    Destination repo (contract index source).",
    "  --apply          Write changes to the queue (atomic).",
    "",
    "Example:",
    "  ato q contract-refs fix --ids BL-0001,BL-0002 --dest /path/to/ato --apply --json",
  ],
};

const HELP_TOKENS = new Set(["--help", "-h", "help"]);

const resolveQueueHelpKey = (
  subcommand: string | null,
  action: string | null,
): string => {
  if (!subcommand || HELP_TOKENS.has(subcommand)) return "root";
  if (subcommand === "contract-refs" && action === "fix") {
    return "contract-refs fix";
  }
  return subcommand;
};

const getQueueHelp = (
  subcommand: string | null,
  action: string | null,
): string[] => {
  const rootHelp = QUEUE_HELP["root"] ?? [];
  const key = resolveQueueHelpKey(subcommand, action);
  if (key === "root") return rootHelp;
  const help = QUEUE_HELP[key];
  if (help) return help;
  return ["Unknown queue subcommand.", "", ...rootHelp];
};

const renderItemLine = (item: QueueItem): string => {
  const target = formatTarget(item.target);
  const tags = (item.tags ?? []).join(", ") || "none";
  const deps = (item.deps ?? []).join(", ") || "none";
  return `- ${item.id} [${item.priority}] ${item.status} — ${item.title} | target: ${target} | tags: ${tags} | deps: ${deps}`;
};

const EXTERNAL_INTAKE_CONTRACT_REF = "6.4";
const CONTRACT_REFS_PROVENANCE_PREFIX = "ContractRefsOriginal:";

const appendNoteLine = (notes: string | undefined, line: string): string => {
  const current = typeof notes === "string" ? notes.trimEnd() : "";
  if (current.includes(line)) return current;
  return current ? `${current}\n${line}` : line;
};

const formatContractRef = (ref: ContractRef): string => {
  if (typeof ref === "string") return ref;
  return `${ref.doc}#${ref.section}`;
};

const renderQueueIdList = (ids: string[]): string => {
  if (!ids.length) return "- None.";
  return ids.map((id) => `- ${id}`).join("\n");
};

const parseDelimitedList = (value: unknown, delimiter: string): string[] => {
  if (!value) return [];
  return String(value)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const parseTagFilter = (flags: Record<string, string | boolean>): string[] => {
  const raw =
    typeof flags["tag"] === "string"
      ? flags["tag"]
      : typeof flags["tags"] === "string"
        ? flags["tags"]
        : null;
  if (!raw) return [];
  return parseDelimitedList(raw, ",");
};

const normalizeTargetValue = (value?: string): string | undefined => {
  if (!value) return value;
  return value.replace(/^(range|exact|milestone):/, "");
};

const parseTargetFilter = (value: string): QueueTarget => {
  const trimmed = value.trim();
  if (trimmed.startsWith("range:")) {
    return { selector: "range", value: trimmed.slice("range:".length) };
  }
  if (trimmed.startsWith("exact:")) {
    return { selector: "exact", value: trimmed.slice("exact:".length) };
  }
  if (trimmed.startsWith("milestone:")) {
    return { selector: "milestone", value: trimmed.slice("milestone:".length) };
  }
  return parseTargetInput(trimmed);
};

const matchesTargetFilter = (
  itemTarget: QueueTarget,
  filterTarget: QueueTarget,
): boolean => {
  const itemSelector = itemTarget.selector ?? itemTarget.kind ?? "unbounded";
  const filterSelector = filterTarget.selector ?? filterTarget.kind ?? "unbounded";
  if (filterSelector === "unbounded") {
    return itemSelector === "unbounded";
  }
  if (itemSelector !== filterSelector) return false;
  const itemValue = normalizeTargetValue(itemTarget.value);
  const filterValue = normalizeTargetValue(filterTarget.value);
  if (!filterValue) return true;
  return itemValue === filterValue;
};

const parseContractRefsFlag = (value: unknown): ContractRef[] => {
  if (!value) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as ContractRef | ContractRef[];
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const deepMerge = <T>(base: T, patch: PlainObject): T => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const merged: PlainObject = { ...(base as PlainObject) };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = (base as PlainObject)[key];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      merged[key] = deepMerge(baseValue, value);
    } else {
      merged[key] = value;
    }
  }
  return merged as T;
};

const buildBacklogView = (items: QueueItem[]): string => {
  const openItems = items.filter(
    (item) => !["done", "dropped"].includes(item.status),
  );
  const grouped = {
    active: openItems.filter((item) => item.status === "active"),
    queued: openItems.filter((item) => item.status === "queued"),
    blocked: openItems.filter((item) => item.status === "blocked"),
  };

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# BACKLOG (Generated View)",
    "",
    "Purpose: Human-readable backlog view sourced from the queue store.",
    "",
    "## Active",
    grouped.active.length
      ? sortItems(grouped.active).map(renderItemLine).join("\n")
      : "- None.",
    "",
    "## Queued",
    grouped.queued.length
      ? sortItems(grouped.queued).map(renderItemLine).join("\n")
      : "- None.",
    "",
    "## Blocked",
    grouped.blocked.length
      ? sortItems(grouped.blocked).map(renderItemLine).join("\n")
      : "- None.",
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const buildStateView = async (items: QueueItem[]): Promise<string> => {
  const activeIds = items
    .filter((item) => item.status === "active")
    .map((item) => item.id)
    .sort();
  const blockedIds = items
    .filter((item) => item.status === "blocked")
    .map((item) => item.id)
    .sort();

  const queuedRecords = items
    .filter((item) => item.status !== "active")
    .map((item) => ({ item }));
  const { selected } = selectNextItems({
    items: queuedRecords,
    target: null,
    focus: null,
    limit: 5,
  });
  const nextSafeIds = selected.map((entry) => entry.item.id);

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# STATE_PRESENT (Generated View)",
    "",
    "Purpose: Present-tense pointers for phase, in-progress IDs, next-safe IDs, and blockers.",
    "",
    "## In Progress (Queue IDs)",
    renderQueueIdList(activeIds),
    "",
    "## Next Safe Work (Queue IDs, dependency-respecting)",
    renderQueueIdList(nextSafeIds),
    "",
    "## Known Blockers (Queue IDs)",
    renderQueueIdList(blockedIds),
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const buildReleasesView = async (items: QueueItem[]): Promise<string> => {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = formatTarget(item.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(item);
  }

  const sortedKeys = [...groups.keys()].sort();
  const threshold = "P2";
  const thresholdRank = priorityRank(threshold);

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# RELEASES (Generated View)",
    "",
    "Purpose: Per-target summaries with deterministic readiness checks.",
    "",
    `Readiness threshold: ${threshold} (open items at or above this priority block readiness).`,
    "",
  ];

  for (const key of sortedKeys) {
    const groupItems = groups.get(key) ?? [];
    const openItems = groupItems.filter(
      (item) => !["done", "dropped"].includes(item.status),
    );
    const doneItems = groupItems.filter((item) => item.status === "done");
    const blocking = openItems.filter(
      (item) => priorityRank(item.priority) <= thresholdRank,
    );
    const readiness = blocking.length ? "blocked" : "ready";

    lines.push(`## ${key}`);
    lines.push(`- Readiness: ${readiness}`);
    lines.push(`- Open items: ${openItems.length}`);
    lines.push(`- Done items: ${doneItems.length}`);

    if (openItems.length) {
      lines.push("");
      lines.push("### Open");
      lines.push(sortItems(openItems).map(renderItemLine).join("\n"));
    }

    if (doneItems.length) {
      lines.push("");
      lines.push("### Done");
      lines.push(sortItems(doneItems).map(renderItemLine).join("\n"));
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

const buildNeedsView = (items: QueueItem[]): string => {
  const allNeeds: Array<
    QueueNeed & { queue_id: string; queue_title: string; target: QueueTarget }
  > = [];

  for (const item of items) {
    const needs = item.details?.needs ?? [];
    for (const need of needs) {
      if (need.status === "open") {
        allNeeds.push({
          queue_id: item.id,
          queue_title: item.title,
          target: item.target,
          ...need,
        });
      }
    }
  }

  const grouped = new Map<
    string,
    Array<QueueNeed & { queue_id: string; queue_title: string; target: QueueTarget }>
  >();
  for (const need of allNeeds) {
    const targetKey = formatTarget(need.target);
    if (!grouped.has(targetKey)) grouped.set(targetKey, []);
    grouped.get(targetKey)?.push(need);
  }

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl (details.needs)"),
    "# NEEDS (Generated View)",
    "",
    "Purpose: Open needs grouped by target.",
    "",
    `Total open needs: ${allNeeds.length}`,
    "",
  ];

  const sortedKeys = [...grouped.keys()].sort();
  for (const key of sortedKeys) {
    const needs = grouped.get(key) ?? [];
    lines.push(`## ${key}`);
    lines.push("");
    for (const need of needs) {
      lines.push(`- **${need.kind}** (${need.queue_id}): ${need.ask}`);
      if (need.evidence) lines.push(`  - Evidence: ${need.evidence}`);
    }
    lines.push("");
  }

  if (allNeeds.length === 0) {
    lines.push("No open needs.");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

export const writeViews = async (
  store: string,
  items: QueueItem[],
): Promise<void> => {
  const { viewsDir } = getQueuePaths(store);
  await fs.mkdir(viewsDir, { recursive: true });
  await fs.writeFile(
    path.join(viewsDir, "BACKLOG.md"),
    buildBacklogView(items),
  );
  await fs.writeFile(
    path.join(viewsDir, "STATE_PRESENT.md"),
    await buildStateView(items),
  );
  await fs.writeFile(
    path.join(viewsDir, "RELEASES.md"),
    await buildReleasesView(items),
  );
  await fs.writeFile(path.join(viewsDir, "NEEDS.md"), buildNeedsView(items));
};

const findItem = (
  items: QueueItem[],
  id: string,
): { index: number; item: QueueItem } => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`Unknown ID: ${id}`);
  }
  const item = items[index];
  if (!item) {
    throw new Error(`Queue item missing at index ${index}.`);
  }
  return { index, item };
};

const loadQueueForWrite = async (
  target: TargetContext,
): Promise<{
  items: QueueItem[];
  validation: Awaited<ReturnType<typeof validateQueueItems>>;
}> => {
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
  return { items, validation };
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

const cmdAdd = async (
  target: TargetContext,
  title: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<void> => {
  if (!title) throw new Error('Usage: ato q add "TITLE" [--type T]');

  const { items, validation } = await loadQueueForWrite(target);
  ensureQueueValid(validation);
  const origin = await resolveCrossRepoOrigin(target);
  const id = nextQueueId(items);

  const typeValue =
    typeof flags["type"] === "string" ? flags["type"] : "feature";
  if (!ALLOWED_TYPES.has(typeValue)) {
    throw new Error(`Invalid --type '${typeValue}'.`);
  }
  const type = typeValue as QueueItem["type"];

  const targetValue =
    typeof flags["queue-target"] === "string"
      ? flags["queue-target"]
      : typeof flags["queueTarget"] === "string"
        ? flags["queueTarget"]
        : "unbounded";
  const targetValueObj = parseTargetInput(targetValue);
  if (targetValueObj.selector === "unbounded") {
    throw new Error(
      "Invalid queue target: open items must target exact/range/milestone. Use --queue-target.",
    );
  }

  const priorityValue =
    typeof flags["priority"] === "string" ? flags["priority"] : "P2";
  const numericPriority = Number(priorityValue);
  let priority: QueuePriority = priorityValue as QueuePriority;
  if (
    Number.isInteger(numericPriority) &&
    numericPriority >= 0 &&
    numericPriority <= 4
  ) {
    priority = numericPriority;
  }
  if (
    !ALLOWED_PRIORITIES.has(String(priority)) &&
    typeof priority !== "number"
  ) {
    throw new Error(`Invalid --priority '${priority}'. Use P0..P4.`);
  }

  const problem = flags["problem"] ? String(flags["problem"]).trim() : "";
  const outcome = flags["outcome"] ? String(flags["outcome"]).trim() : "";
  const planStepsRaw =
    flags["plan-steps"] ?? flags["planSteps"] ?? null;
  const planSteps = parseDelimitedList(planStepsRaw, "|");
  const planRationaleRaw =
    flags["plan-rationale"] ?? flags["planRationale"] ?? null;
  const planRationale = planRationaleRaw
    ? String(planRationaleRaw).trim()
    : "";
  const acceptanceCriteria = parseDelimitedList(flags["acceptance"], "|");
  const inputs = parseDelimitedList(flags["inputs"], "|");
  const deliverables = parseDelimitedList(flags["deliverables"], "|");
  const scope = parseDelimitedList(flags["scope"], "|");
  const risks = parseDelimitedList(flags["risks"], "|");
  const runbook = parseDelimitedList(flags["runbook"], "|");
  const contractRefsRaw =
    flags["contract-refs"] ?? flags["contractRefs"] ?? null;

  let contractRefs: ContractRef[] = [];
  if (contractRefsRaw) {
    try {
      contractRefs = parseContractRefsFlag(contractRefsRaw);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      throw new Error(`Invalid --contract-refs: ${message}`);
    }
  }

  const missing: string[] = [];
  if (!problem) missing.push("problem");
  if (!outcome) missing.push("outcome");
  if (!planSteps.length) missing.push("plan-steps");
  if (!acceptanceCriteria.length) missing.push("acceptance");
  if (!inputs.length) missing.push("inputs");
  if (!deliverables.length) missing.push("deliverables");

  if (missing.length) {
    const error = new Error("Missing required spec fields.");
    (error as Error & { details?: unknown }).details = {
      missing,
      spec_skeleton: {
        problem: "<problem>",
        outcome: "<outcome>",
        plan: {
          steps: ["<step>"],
        },
        acceptance_criteria: ["<acceptance>"],
        inputs: ["<input>"],
        deliverables: ["<deliverable>"],
        scope: [],
        risks: [],
        contract_refs: [],
        runbook: [],
      },
    };
    throw error;
  }

  const spec = {
    problem,
    outcome,
    plan: {
      steps: planSteps,
      ...(planRationale ? { rationale: planRationale } : {}),
    },
    acceptance_criteria: acceptanceCriteria,
    inputs,
    deliverables,
    scope,
    risks,
    contract_refs: contractRefs,
    runbook,
  };

  const links = parseDelimitedList(flags["links"], "|");
  const details: Record<string, unknown> = {
    ...(flags["rationale"]
      ? { rationale: String(flags["rationale"]).trim() }
      : {}),
    ...(links.length ? { links } : {}),
  };

  const baseTags = flags["tags"]
    ? normalizeTags(
        String(flags["tags"])
          .split(",")
          .map((entry) => entry.trim()),
      )
    : [];
  const tags = normalizeTags([...baseTags]);

  const item: QueueItem = applyOriginIfMissing(
    {
      id,
      title,
      type,
      status: "queued",
      priority,
      tags,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target: targetValueObj,
    deps: flags["deps"]
      ? normalizeDeps(
          String(flags["deps"])
            .split(",")
            .map((entry) => entry.trim()),
        )
      : [],
    evidence: flags["evidence"]
      ? normalizeEvidence(
          String(flags["evidence"])
            .split(",")
            .map((entry) => entry.trim()),
        )
      : [],
    owner: typeof flags["owner"] === "string" ? flags["owner"] : "agent",
    notes: flags["notes"] ? String(flags["notes"]) : "",
      spec,
      ...(Object.keys(details).length ? { details } : {}),
    },
    origin,
  );

  items.push(item);
  const schema = await loadQueueSchema();
  const nextValidation = await validateQueueItems({
    items,
    schema,
    config: target.config,
    root: target.root,
    store: target.storePath,
  });
  ensureQueueValid(nextValidation);
  await writeQueueItems(target.storePath, items);
  await writeViews(target.storePath, items);

  await appendRunLog(target.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_transition",
    target_id: target.id,
    queue_id: id,
    commands: [],
    artifacts: [],
    summary: "queue add",
  });

  if (json) {
    writeJson({ ok: true, id, title, target: formatTarget(item.target) });
  } else {
    writeLines([formatTargetLine(target), `add: ${id}`]);
  }
};

const cmdIntake = async ({
  destTarget,
  flags,
  json,
  sourceRepo,
}: {
  destTarget: TargetContext;
  flags: Record<string, string | boolean>;
  json: boolean;
  sourceRepo: string;
}): Promise<void> => {
  const fileValue = flags["file"];
  if (typeof fileValue !== "string" || !fileValue.trim()) {
    throw new Error("Usage: ato q intake --file <candidate.json> [options]");
  }
  const dryRun = Boolean(flags["dry-run"] || flags["dryRun"]);
  const telemetryRef =
    typeof flags["telemetry-ref"] === "string"
      ? flags["telemetry-ref"].trim()
      : typeof flags["telemetryRef"] === "string"
        ? flags["telemetryRef"].trim()
        : "";

  const candidate = await readJsonFileStrict(fileValue.trim());
  const { items, validation } = await loadQueueForWrite(destTarget);
  ensureQueueValid(validation);

  const producerTarget = await resolveProducerTarget(sourceRepo);
  const sourceRoot = producerTarget?.root ?? path.resolve(sourceRepo);
  const originFallback = buildOrigin({ repoRoot: sourceRoot, cwd: sourceRepo });
  const id = nextQueueId(items);
  const ingestedAt = new Date().toISOString();
  const intakeItem = buildIntakeItem({
    candidate,
    id,
    sourceRepo: sourceRoot,
    ingestedAt,
    telemetryRef: telemetryRef || null,
    originFallback,
  });

  const schema = await loadQueueSchema();
  const nextItems = [...items, intakeItem];
  const nextValidation = await validateQueueItems({
    items: nextItems,
    schema,
    config: destTarget.config,
    root: destTarget.root,
    store: destTarget.storePath,
  });
  ensureQueueValid(nextValidation);

  const targetLabel = formatTarget(intakeItem.target);
  if (dryRun) {
    if (json) {
      writeJson({
        ok: true,
        dry_run: true,
        id,
        title: intakeItem.title,
        target: targetLabel,
      });
    } else {
      writeLines([
        formatTargetLine(destTarget),
        `intake (dry-run): ${id}`,
        `title: ${intakeItem.title}`,
        `target: ${targetLabel}`,
      ]);
    }
    return;
  }

  await writeQueueItems(destTarget.storePath, nextItems);
  await writeViews(destTarget.storePath, nextItems);

  await appendRunLog(destTarget.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_transition",
    target_id: destTarget.id,
    queue_id: id,
    commands: [],
    artifacts: [],
    summary: "queue intake",
  });

  if (json) {
    writeJson({ ok: true, id, title: intakeItem.title, target: targetLabel });
  } else {
    writeLines([formatTargetLine(destTarget), `intake: ${id}`]);
  }
};

const cmdTransfer = async ({
  sourceTarget,
  destTarget,
  id,
  flags,
  json,
}: {
  sourceTarget: TargetContext;
  destTarget: TargetContext;
  id: string | null;
  flags: Record<string, string | boolean>;
  json: boolean;
}): Promise<void> => {
  const allFlag = flags["all"];
  if (typeof allFlag === "string") {
    throw new Error("Unexpected value for --all.");
  }
  const isBatch = Boolean(allFlag);
  if (isBatch && id) {
    throw new Error("Do not provide an id when using --all.");
  }
  if (!isBatch && !id) {
    throw new Error("Usage: ato q transfer <id> [options]");
  }

  if (!isBatch && flags["status"] !== undefined) {
    throw new Error("The --status flag requires --all.");
  }

  const dryRun = Boolean(flags["dry-run"] || flags["dryRun"]);

  const statusFilter = isBatch ? parseStatusFilter(flags["status"]) : null;

  const { items, validation } = await loadQueueForWrite(destTarget);
  ensureQueueValid(validation);

  const sourceGitHead = readGitHead(sourceTarget.root);
  const originFallback = buildOrigin({
    repoRoot: sourceTarget.root,
    cwd: sourceTarget.root,
  });
  const transferTimestamp = new Date().toISOString();

  const applyAudit = (item: QueueItem, sourceId: string): QueueItem => {
    const auditParts = [
      `source_repo_path=${sourceTarget.root}`,
      `source_item_id=${sourceId}`,
      `transfer_timestamp=${transferTimestamp}`,
    ];
    if (sourceGitHead) {
      auditParts.push(`source_git_head=${sourceGitHead}`);
    }
    const auditLine = `Transfer: ${auditParts.join("; ")}`;
    const notes = item.notes ? `${item.notes}\n${auditLine}` : auditLine;
    return { ...item, notes };
  };

  if (isBatch) {
    const sourceRecords = await readQueueItems(sourceTarget.storePath);
    const selected = sourceRecords
      .map((record) => record.item)
      .filter((item) => statusFilter?.includes(item.status));
    if (!selected.length) {
      throw new Error("No source items matched for transfer.");
    }

    const ordered = [...selected].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );
    const mapping: Record<string, string> = {};
    const transferItems: QueueItem[] = [];
    let currentItems = [...items];
    for (const sourceItem of ordered) {
      const nextId = nextQueueId(currentItems);
      const intakeItem = buildIntakeItem({
        candidate: sourceItem,
        id: nextId,
        sourceRepo: sourceTarget.root,
        ingestedAt: transferTimestamp,
        telemetryRef: null,
        originFallback,
      });
      const transferItem = applyAudit(intakeItem, sourceItem.id);
      transferItems.push(transferItem);
      mapping[sourceItem.id] = nextId;
      currentItems = [...currentItems, transferItem];
    }

    const schema = await loadQueueSchema();
    const nextItems = [...items, ...transferItems];
    const nextValidation = await validateQueueItems({
      items: nextItems,
      schema,
      config: destTarget.config,
      root: destTarget.root,
      store: destTarget.storePath,
    });
    ensureQueueValid(nextValidation);

    const targetLabel = formatTarget(transferItems[0]?.target ?? null);
    if (dryRun) {
      if (json) {
        writeJson({
          ok: true,
          dry_run: true,
          mode: "batch",
          target: targetLabel,
          source: sourceTarget.root,
          mapping,
          counts: { selected: ordered.length, transferred: ordered.length },
          audit: {
            source_repo_path: sourceTarget.root,
            transfer_timestamp: transferTimestamp,
            source_git_head: sourceGitHead,
            statuses: statusFilter,
          },
        });
      } else {
        writeLines([
          formatTargetLine(destTarget),
          `transfer (dry-run): ${ordered.length} items`,
        ]);
      }
      return;
    }

    await writeQueueItems(destTarget.storePath, nextItems);
    await writeViews(destTarget.storePath, nextItems);

    await appendRunLog(destTarget.storePath, {
      ts: new Date().toISOString(),
      kind: "queue_transition",
      target_id: destTarget.id,
      queue_ids: Object.values(mapping),
      commands: [],
      artifacts: [],
      summary: "queue transfer (batch)",
    });

    if (json) {
      writeJson({
        ok: true,
        mode: "batch",
        target: targetLabel,
        source: sourceTarget.root,
        mapping,
        counts: { selected: ordered.length, transferred: ordered.length },
        audit: {
          source_repo_path: sourceTarget.root,
          transfer_timestamp: transferTimestamp,
          source_git_head: sourceGitHead,
          statuses: statusFilter,
        },
      });
    } else {
      writeLines([
        formatTargetLine(destTarget),
        `transfer: ${ordered.length} items`,
      ]);
    }
    return;
  }

  const sourceRecords = await readQueueItems(sourceTarget.storePath);
  const sourceItem =
    sourceRecords.find((record) => record.item.id === id)?.item ?? null;
  if (!sourceItem) {
    throw new Error(`Unknown queue id '${id}' in source repo.`);
  }

  const nextId = nextQueueId(items);
  const intakeItem = buildIntakeItem({
    candidate: sourceItem,
    id: nextId,
    sourceRepo: sourceTarget.root,
    ingestedAt: transferTimestamp,
    telemetryRef: null,
    originFallback,
  });

  const transferItem = applyAudit(intakeItem, sourceItem.id);

  const schema = await loadQueueSchema();
  const nextItems = [...items, transferItem];
  const nextValidation = await validateQueueItems({
    items: nextItems,
    schema,
    config: destTarget.config,
    root: destTarget.root,
    store: destTarget.storePath,
  });
  ensureQueueValid(nextValidation);

  const targetLabel = formatTarget(transferItem.target);
  if (dryRun) {
    if (json) {
      writeJson({
        ok: true,
        dry_run: true,
        id: nextId,
        title: transferItem.title,
        target: targetLabel,
        source: sourceTarget.root,
      });
    } else {
      writeLines([
        formatTargetLine(destTarget),
        `transfer (dry-run): ${nextId}`,
        `title: ${transferItem.title}`,
        `source: ${sourceTarget.root}`,
      ]);
    }
    return;
  }

  await writeQueueItems(destTarget.storePath, nextItems);
  await writeViews(destTarget.storePath, nextItems);

  await appendRunLog(destTarget.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_transition",
    target_id: destTarget.id,
    queue_id: nextId,
    commands: [],
    artifacts: [],
    summary: "queue transfer",
  });

  if (json) {
    writeJson({
      ok: true,
      id: nextId,
      title: transferItem.title,
      target: targetLabel,
      source: sourceTarget.root,
    });
  } else {
    writeLines([formatTargetLine(destTarget), `transfer: ${nextId}`]);
  }
};

type ContractRefsFixReport = {
  id: string;
  changed: boolean;
  before: ContractRef[];
  after: ContractRef[];
  invalid_refs: string[];
  valid_refs: string[];
  provenance: {
    origin_contract_refs_added: boolean;
    note_added: boolean;
    note: string | null;
  };
};

const cmdContractRefsFix = async ({
  sourceTarget,
  destTarget,
  ids,
  apply,
  json,
}: {
  sourceTarget: TargetContext;
  destTarget: TargetContext;
  ids: string[];
  apply: boolean;
  json: boolean;
}): Promise<void> => {
  if (!ids.length) {
    throw new Error("Usage: ato q contract-refs fix --ids <id,...> --dest <dest>");
  }

  const { items, validation } = await loadQueueForWrite(sourceTarget);
  ensureQueueValid(validation);

  const indexPath = path.join(destTarget.storePath, "cache", "contracts.index.json");
  const index = await readJsonFile<ContractIndex>(indexPath, null);
  if (!index) {
    throw new Error(
      "Missing destination contract index. Run `ato --repo <dest> contract index`.",
    );
  }

  const defaultDoc = resolveDocPath(destTarget.config, null);
  const orderedIds = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const reports: ContractRefsFixReport[] = [];
  const changedIds: string[] = [];
  const updatedItems = [...items];
  const updatedById = new Map<string, QueueItem>();

  const resolveRef = (ref: ContractRef): { doc: string; section: string } | null => {
    if (typeof ref === "string") {
      return defaultDoc ? { doc: defaultDoc, section: ref } : null;
    }
    if (!ref?.doc || !ref.section) return null;
    return { doc: ref.doc, section: ref.section };
  };

  for (const id of orderedIds) {
    const item = itemsById.get(id);
    if (!item) {
      throw new Error(`Unknown queue id '${id}'.`);
    }
    const currentRefs = Array.isArray(item.spec?.contract_refs)
      ? item.spec.contract_refs
      : [];
    const invalid: string[] = [];
    const valid: string[] = [];
    for (const ref of currentRefs) {
      const resolved = resolveRef(ref);
      if (!resolved) {
        invalid.push(formatContractRef(ref));
        continue;
      }
      const docKey = toContractDocKey(destTarget.root, resolved.doc);
      const entry = resolveSectionFromIndex({
        index,
        doc: docKey,
        section: resolved.section,
      });
      if (!entry) {
        invalid.push(formatContractRef(ref));
      } else {
        valid.push(formatContractRef(ref));
      }
    }

    invalid.sort((a, b) => a.localeCompare(b));
    valid.sort((a, b) => a.localeCompare(b));
    const needsFix = invalid.length > 0;
    const afterRefs = needsFix ? [EXTERNAL_INTAKE_CONTRACT_REF] : currentRefs;

    let originAdded = false;
    let noteAdded = false;
    let noteLine: string | null = null;
    let nextOrigin = item.origin;
    let nextNotes = item.notes;

    if (needsFix) {
      if (nextOrigin) {
        if (!Array.isArray(nextOrigin.contract_refs) || !nextOrigin.contract_refs.length) {
          nextOrigin = { ...nextOrigin, contract_refs: currentRefs };
          originAdded = true;
        }
      } else {
        noteLine = `${CONTRACT_REFS_PROVENANCE_PREFIX} ${stableStringify(currentRefs)}`;
        const updatedNotes = appendNoteLine(nextNotes, noteLine);
        noteAdded = updatedNotes !== nextNotes;
        nextNotes = updatedNotes;
      }

      if (apply) {
        const updated: QueueItem = {
          ...item,
          spec: {
            ...item.spec,
            contract_refs: [EXTERNAL_INTAKE_CONTRACT_REF],
          },
          notes: nextNotes,
          ...(nextOrigin ? { origin: nextOrigin } : {}),
          updated_at: new Date().toISOString(),
        };
        updatedById.set(item.id, updated);
        changedIds.push(item.id);
      }
    }

    reports.push({
      id: item.id,
      changed: needsFix,
      before: currentRefs,
      after: afterRefs,
      invalid_refs: invalid,
      valid_refs: valid,
      provenance: {
        origin_contract_refs_added: originAdded,
        note_added: noteAdded,
        note: noteLine,
      },
    });
  }

  if (apply && updatedById.size) {
    for (let i = 0; i < updatedItems.length; i += 1) {
      const item = updatedItems[i];
      if (!item) continue;
      const updated = updatedById.get(item.id);
      if (updated) updatedItems[i] = updated;
    }
    const schema = await loadQueueSchema();
    const nextValidation = await validateQueueItems({
      items: updatedItems,
      schema,
      config: sourceTarget.config,
      root: sourceTarget.root,
      store: sourceTarget.storePath,
    });
    ensureQueueValid(nextValidation);
    await writeQueueItems(sourceTarget.storePath, updatedItems);
    await writeViews(sourceTarget.storePath, updatedItems);
    await appendRunLog(sourceTarget.storePath, {
      ts: new Date().toISOString(),
      kind: "queue_update",
      target_id: sourceTarget.id,
      queue_ids: changedIds,
      commands: [],
      artifacts: [],
      summary: "queue contract-refs fix",
    });
  }

  const blockedIds = reports
    .filter((entry) => entry.changed)
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b));

  const payload = {
    ok: true,
    apply,
    source: sourceTarget.root,
    destination: destTarget.root,
    contract_ref: EXTERNAL_INTAKE_CONTRACT_REF,
    ids: orderedIds,
    blocked_ids: blockedIds,
    counts: {
      selected: orderedIds.length,
      changed: blockedIds.length,
      unchanged: orderedIds.length - blockedIds.length,
    },
    items: reports,
  };

  if (json) {
    writeJson(payload);
  } else {
    writeLines([
      formatTargetLine(sourceTarget),
      `contract-refs fix: ${apply ? "applied" : "plan"}`,
      `items: ${orderedIds.length}`,
      `changed: ${blockedIds.length}`,
    ]);
  }
};

const cmdUpdate = async (
  target: TargetContext,
  id: string | null,
  flags: Record<string, string | boolean>,
  args: string[],
  json: boolean,
): Promise<void> => {
  if (!id) throw new Error("Usage: ato q update <id> [options]");
  const { items, validation } = await loadQueueForWrite(target);
  ensureQueueValid(validation);
  const origin = await resolveCrossRepoOrigin(target);

  const found = findItem(items, id);

  const inputProvided = typeof flags["input"] === "string";
  const addTags = collectFlagValues(args, "add-tag");
  const removeTags = collectFlagValues(args, "remove-tag");
  const notes = collectFlagValues(args, "note");
  const outcomeValues = collectFlagValues(args, "outcome");
  const planStepsValues = collectFlagValues(args, "plan-steps");
  const planRationaleValues = collectFlagValues(args, "plan-rationale");
  const acceptanceAdds = collectFlagValues(args, "acceptance-add");
  const acceptanceSetValues = collectFlagValues(args, "acceptance-set");
  const evidenceAdds = collectFlagValues(args, "evidence-add");
  const statusValues = collectFlagValues(args, "status");
  const priorityValues = collectFlagValues(args, "priority");
  const targetValues = [
    ...collectFlagValues(args, "queue-target"),
    ...collectFlagValues(args, "queueTarget"),
  ];

  const usedFlagCount =
    addTags.length +
    removeTags.length +
    notes.length +
    outcomeValues.length +
    planStepsValues.length +
    planRationaleValues.length +
    acceptanceAdds.length +
    acceptanceSetValues.length +
    evidenceAdds.length +
    statusValues.length +
    priorityValues.length +
    targetValues.length;

  if (inputProvided && usedFlagCount > 0) {
    throw new Error("Use either --input or flags, not both.");
  }
  if (!inputProvided && usedFlagCount === 0) {
    throw new Error("Provide --input or at least one update flag.");
  }
  if (acceptanceSetValues.length > 1) {
    throw new Error("Provide a single --acceptance-set value.");
  }
  if (acceptanceSetValues.length && acceptanceAdds.length) {
    throw new Error("Use either --acceptance-add or --acceptance-set, not both.");
  }
  if (priorityValues.length > 1) {
    throw new Error("Provide a single --priority value.");
  }
  if (statusValues.length > 1) {
    throw new Error("Provide a single --status value.");
  }
  if (targetValues.length > 1) {
    throw new Error("Provide a single --queue-target value.");
  }
  if (outcomeValues.length > 1) {
    throw new Error("Provide a single --outcome value.");
  }
  if (planStepsValues.length > 1) {
    throw new Error("Provide a single --plan-steps value.");
  }
  if (planRationaleValues.length > 1) {
    throw new Error("Provide a single --plan-rationale value.");
  }

  let nextItem = found.item;

  if (inputProvided) {
    const parsed = await parseJsonInput(flags["input"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const patch = parsed.value as PlainObject;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("--input must be a JSON object.");
    }
    if (typeof patch["id"] === "string" && patch["id"] !== id) {
      throw new Error("Patch id does not match target id.");
    }
    nextItem = deepMerge(nextItem, patch) as QueueItem;
  } else {
    const updated: QueueItem = { ...nextItem };

    if (priorityValues.length) {
      const priorityValue = String(priorityValues[0]);
      const numericPriority = Number(priorityValue);
      let priority: QueuePriority = priorityValue as QueuePriority;
      if (
        Number.isInteger(numericPriority) &&
        numericPriority >= 0 &&
        numericPriority <= 4
      ) {
        priority = numericPriority;
      }
      if (
        !ALLOWED_PRIORITIES.has(String(priority)) &&
        typeof priority !== "number"
      ) {
        throw new Error(`Invalid --priority '${priority}'. Use P0..P4.`);
      }
      updated.priority = priority;
    }

    if (statusValues.length) {
      const statusValue = String(statusValues[0]);
      if (!ALLOWED_STATUSES.has(statusValue)) {
        throw new Error(`Invalid --status '${statusValue}'.`);
      }
      const allowedStatuses = ["queued", "blocked", "dropped"];
      if (!allowedStatuses.includes(statusValue)) {
        const details = {
          attempted_status: statusValue,
          allowed: allowedStatuses,
        };
        const suggestedFix = [
          "Use `ato cycle start --json` to start work",
          "Use `ato cycle finish --json` to complete work",
        ];
        if (json) {
          writeJson({
            ok: false,
            code: "STATUS_TRANSITION_DISALLOWED",
            details,
            suggested_fix: suggestedFix,
          });
          process.exitCode = 3;
          return;
        }
        const error = new Error(
          "Status transition disallowed for q update; use cycle start/finish.",
        );
        (error as Error & { code?: string; details?: unknown }).code =
          "STATUS_TRANSITION_DISALLOWED";
        (error as Error & { details?: unknown }).details = {
          ...details,
          suggested_fix: suggestedFix,
        };
        throw error;
      }
      updated.status = statusValue as QueueItem["status"];
    }

    if (targetValues.length) {
      const targetValue = String(targetValues[0]).trim();
      if (!targetValue) {
        throw new Error("Missing value for --queue-target.");
      }
      let normalizedTarget = targetValue;
      if (normalizedTarget.startsWith("range:")) {
        normalizedTarget = normalizedTarget.slice("range:".length);
      } else if (normalizedTarget.startsWith("exact:")) {
        normalizedTarget = normalizedTarget.slice("exact:".length);
      }
      updated.target = parseTargetInput(normalizedTarget);
    }

    if (addTags.length || removeTags.length) {
      const existingTags = Array.isArray(updated.tags)
        ? updated.tags.map((tag) => String(tag))
        : [];
      const tagSet = new Set(existingTags);
      for (const tag of addTags) {
        if (tag) tagSet.add(tag);
      }
      for (const tag of removeTags) {
        tagSet.delete(tag);
      }
      updated.tags = [...tagSet].sort((a, b) => a.localeCompare(b));
    }

    if (notes.length) {
      const existingNotes =
        typeof updated.notes === "string" ? updated.notes.trim() : "";
      const appended = notes.join("\n");
      updated.notes = existingNotes
        ? `${existingNotes}\n${appended}`
        : appended;
    }

    let spec = updated.spec;
    if (
      (outcomeValues.length ||
        planStepsValues.length ||
        planRationaleValues.length ||
        acceptanceAdds.length ||
        acceptanceSetValues.length ||
        evidenceAdds.length) &&
      (!spec || typeof spec !== "object")
    ) {
      throw new Error(`Queue item '${id}' is missing a spec payload.`);
    }

    if (outcomeValues.length) {
      const nextOutcome = String(outcomeValues[0]).trim();
      if (!nextOutcome) {
        throw new Error("Missing value for --outcome.");
      }
      updated.spec = {
        ...(spec as QueueSpec),
        outcome: nextOutcome,
      };
      spec = updated.spec;
    }

    if (planStepsValues.length || planRationaleValues.length) {
      const currentPlan =
        spec && typeof spec.plan === "object" && spec.plan ? spec.plan : null;
      const planStepsSource = planStepsValues.length
        ? planStepsValues[0]
        : null;
      const currentSteps = Array.isArray(currentPlan?.steps)
        ? currentPlan.steps.map((step) => String(step).trim()).filter(Boolean)
        : [];
      const nextSteps = planStepsSource
        ? parseDelimitedList(planStepsSource, "|")
        : currentSteps;
      if (!nextSteps.length) {
        throw new Error("Missing value for --plan-steps.");
      }
      const planRationaleRaw = planRationaleValues.length
        ? String(planRationaleValues[0]).trim()
        : "";
      const nextPlan = {
        steps: nextSteps,
        ...(planRationaleRaw ? { rationale: planRationaleRaw } : {}),
      };
      updated.spec = {
        ...(updated.spec as QueueSpec),
        plan: nextPlan,
      };
      spec = updated.spec;
    }

    if (acceptanceAdds.length || acceptanceSetValues.length) {
      const nextAcceptance: string[] = [];
      if (acceptanceSetValues.length) {
        const raw = acceptanceSetValues[0];
        if (!raw) {
          throw new Error("Missing value for --acceptance-set.");
        }
        if (!raw.startsWith("@")) {
          throw new Error("Use --acceptance-set @<file.json>.");
        }
        const parsed = await parseJsonInput(raw.slice(1));
        if (!parsed.ok) throw new Error(parsed.error);
        if (!Array.isArray(parsed.value)) {
          throw new Error("--acceptance-set must point to a JSON array.");
        }
        for (const entry of parsed.value) {
          const trimmed = String(entry).trim();
          if (trimmed) nextAcceptance.push(trimmed);
        }
      } else {
        const existingAcceptance = Array.isArray(spec?.acceptance_criteria)
          ? spec.acceptance_criteria.map((entry) => String(entry))
          : [];
        nextAcceptance.push(...existingAcceptance);
        for (const entry of acceptanceAdds) {
          const trimmed = String(entry).trim();
          if (trimmed) nextAcceptance.push(trimmed);
        }
      }
      updated.spec = {
        ...(spec as QueueSpec),
        acceptance_criteria: nextAcceptance,
      };
    }

    if (evidenceAdds.length) {
      const nextInputs = Array.isArray(spec?.inputs)
        ? spec.inputs.map((entry) => String(entry))
        : [];
      for (const entry of evidenceAdds) {
        const trimmed = String(entry).trim();
        if (!trimmed) continue;
        if (!isInputCitation(trimmed)) {
          throw new Error(
            `Invalid --evidence-add '${trimmed}'. Use ${INPUT_CITATION_PREFIX_MESSAGE}.`,
          );
        }
        nextInputs.push(trimmed);
      }
      updated.spec = {
        ...(updated.spec as QueueSpec),
        inputs: nextInputs,
      };
    }

    nextItem = updated;
  }

  const merged = applyOriginIfMissing(nextItem, origin);
  const updated = { ...merged, id, updated_at: new Date().toISOString() };
  items[found.index] = updated;

  const schema = await loadQueueSchema();
  const nextValidation = await validateQueueItems({
    items,
    schema,
    config: target.config,
    root: target.root,
    store: target.storePath,
  });
  ensureQueueValid(nextValidation);

  await writeQueueItems(target.storePath, items);
  await writeViews(target.storePath, items);

  await appendRunLog(target.storePath, {
    ts: new Date().toISOString(),
    kind: "queue_update",
    target_id: target.id,
    queue_id: id,
    commands: [],
    artifacts: [],
    summary: "queue update",
  });

  if (json) {
    writeJson({ ok: true, id });
  } else {
    writeLines([formatTargetLine(target), `update: ${id}`]);
  }
};

const cmdTrace = async (
  target: TargetContext,
  id: string | null,
  json: boolean,
): Promise<void> => {
  if (!id) throw new Error("Usage: ato q trace <id>");
  const records = await readQueueItems(target.storePath);
  const items = records.map((record) => record.item);
  const found = items.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Unknown ID: ${id}`);
  }

  const origin = buildTraceOrigin(found.origin);
  const suggested = buildTraceSuggestions(origin);

  if (json) {
    writeJson({
      ok: true,
      id: found.id,
      title: found.title,
      status: found.status,
      priority: found.priority,
      origin,
      suggested_commands: suggested,
    });
    return;
  }

  const lines = [
    formatTargetLine(target),
    `trace: ${found.id}`,
    `title: ${found.title}`,
    `status: ${found.status}`,
    `priority: ${found.priority}`,
    "origin:",
    `  repo_remote: ${origin.repo_remote ?? "none"}`,
    `  repo_path: ${origin.repo_path ?? "none"}`,
    `  commit: ${origin.commit ?? "none"}`,
    `  subpath: ${origin.subpath ?? "none"}`,
  ];
  if (origin.created_by) {
    lines.push(`  created_by: ${origin.created_by}`);
  }
  lines.push("suggested commands:");
  if (suggested.length) {
    lines.push(...suggested.map((command) => `  - ${command}`));
  } else {
    lines.push("  - none");
  }
  writeLines(lines);
};

const cmdValidate = async (
  target: TargetContext,
  json: boolean,
): Promise<void> => {
  const records = await readQueueItems(target.storePath);
  const items = records.map((record) => record.item);
  const schema = await loadQueueSchema();
  const { errors, contractError } = await validateQueueItems({
    items,
    schema,
    config: target.config,
    root: target.root,
    store: target.storePath,
  });

  const ok = errors.length === 0;
  if (json) {
    writeJson({
      ok,
      schema_version: QUEUE_VALIDATE_SCHEMA_VERSION,
      count: items.length,
      errors,
    });
  } else {
    writeLines([
      `validate: ${ok ? "ok" : "fail"}`,
      `count: ${items.length}`,
      ...errors.map((error) => `- ${error.id}: ${error.message}`),
    ]);
  }

  if (!ok) {
    process.exitCode = contractError ? 6 : 3;
  }
};

const cmdList = async (
  target: TargetContext,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<void> => {
  const records = await readQueueItems(target.storePath);
  const items = records.map((record) => record.item);
  const status = typeof flags["status"] === "string" ? flags["status"] : null;
  if (status && !ALLOWED_STATUSES.has(status)) {
    throw new Error(`Invalid --status '${status}'.`);
  }
  const owner = typeof flags["owner"] === "string" ? flags["owner"].trim() : null;
  const tags = parseTagFilter(flags);
  const targetRaw =
    typeof flags["queue-target"] === "string"
      ? flags["queue-target"]
      : typeof flags["queueTarget"] === "string"
        ? flags["queueTarget"]
        : null;
  const targetFilter = targetRaw ? parseTargetFilter(targetRaw) : null;

  let filtered = items.slice();
  if (status) {
    filtered = filtered.filter((item) => item.status === status);
  }
  if (owner) {
    filtered = filtered.filter((item) => item.owner === owner);
  }
  if (tags.length) {
    filtered = filtered.filter((item) =>
      tags.every((tag) => (item.tags ?? []).includes(tag)),
    );
  }
  if (targetFilter) {
    filtered = filtered.filter((item) =>
      matchesTargetFilter(item.target, targetFilter),
    );
  }

  const ordered = sortItems(filtered);
  const summaries = ordered.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    tags: item.tags ?? [],
    target: item.target,
    owner: item.owner ?? null,
  }));

  if (json) {
    writeJson({
      ok: true,
      schema_version: QUEUE_LIST_SCHEMA_VERSION,
      count: summaries.length,
      items: summaries,
    });
  } else {
    const lines = [
      formatTargetLine(target),
      "queue list",
      `items: ${summaries.length}`,
    ];
    for (const item of summaries) {
      const tagLabel = item.tags.length ? item.tags.join(",") : "none";
      lines.push(
        `- ${item.id} [${item.status}] [${item.priority}] ${item.title} | target: ${formatTarget(item.target)} | tags: ${tagLabel}`,
      );
    }
    writeLines(lines);
  }
};

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const cmdView = async (
  target: TargetContext,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<void> => {
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

  if (json) {
    writeJson({ ok: true, count: items.length });
  } else {
    const quiet = Boolean(flags["quiet"]);
    if (quiet) {
      writeLines([formatTargetLine(target), "view: ok"]);
      return;
    }
    const ordered = sortItems(items);
    const lines = [
      formatTargetLine(target),
      "queue view",
      `items: ${ordered.length}`,
    ];
    for (const item of ordered) {
      const tagLabel = item.tags?.length ? item.tags.join(",") : "none";
      lines.push(
        `- ${item.id} [${item.status}] [${item.priority}] ${item.title}`,
      );
      lines.push(
        `  target: ${formatTarget(item.target)} | tags: ${tagLabel}`,
      );
      const problem =
        typeof item.spec?.problem === "string"
          ? toSingleLine(item.spec.problem)
          : "";
      const outcome =
        typeof item.spec?.outcome === "string"
          ? toSingleLine(item.spec.outcome)
          : "";
      const planSteps = Array.isArray(item.spec?.plan?.steps)
        ? item.spec.plan.steps
        : [];
      if (problem) lines.push(`  problem: ${problem}`);
      if (outcome) lines.push(`  outcome: ${outcome}`);
      if (planSteps.length) {
        lines.push(`  plan: ${planSteps.length} steps`);
      }
    }
    writeLines(lines);
  }
};

export const runQueueCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { flags, positionals } = parseFlags(args);
  const json = context.json;

  const action = positionals[0] ?? null;
  const helpRequested =
    Boolean(flags["help"]) || !subcommand || HELP_TOKENS.has(subcommand);
  if (helpRequested) {
    writeLines(getQueueHelp(subcommand, action));
    return;
  }

  if (subcommand === "list") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await cmdList(target, flags, json);
    return;
  }

  if (subcommand === "trace") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await cmdTrace(target, positionals[0] ?? null, json);
    return;
  }

  if (subcommand === "validate") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await cmdValidate(target, json);
    return;
  }

  if (subcommand === "contract-refs") {
    const action = positionals[0] ?? null;
    if (action !== "fix") {
      throw new Error("Usage: ato q contract-refs fix --ids <id,...> --dest <dest>");
    }
    const idsRaw = flags["ids"];
    if (idsRaw === true || typeof idsRaw !== "string") {
      throw new Error("Usage: ato q contract-refs fix --ids <id,...> --dest <dest>");
    }
    const ids = parseDelimitedList(idsRaw, ",");
    const apply = Boolean(flags["apply"]);
    const destFlag = flags["dest"];
    if (destFlag === true) {
      throw new Error("Missing value for --dest.");
    }
    const destSelection =
      typeof destFlag === "string" && destFlag.trim() ? destFlag.trim() : null;
    if (!destSelection) {
      throw new Error("Missing destination --dest.");
    }
    const { target: sourceTarget } = await resolveTarget({
      cwd: process.cwd(),
      selection: null,
      storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
      requireWrite: apply,
    });
    await ensureProtocol(sourceTarget.root);
    const { target: destTarget } = await resolveTarget({
      cwd: process.cwd(),
      selection: destSelection,
      storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
      requireWrite: false,
    });
    await ensureProtocol(destTarget.root);

    const lockPath = apply
      ? await acquireWriteLock(sourceTarget, sourceTarget.config.lock?.ttlMs)
      : null;
    try {
      await cmdContractRefsFix({
        sourceTarget,
        destTarget,
        ids,
        apply,
        json,
      });
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "view") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    await cmdView(target, flags, json);
    return;
  }

  if (subcommand === "intake") {
    const destFlag = flags["dest"];
    if (destFlag === true) {
      throw new Error("Missing value for --dest.");
    }
    const destSelection =
      typeof destFlag === "string" && destFlag.trim() ? destFlag.trim() : null;
    const dryRun = Boolean(flags["dry-run"] || flags["dryRun"]);
    const allowCrossStoreWrite = Boolean(
      flags["allow-cross-store-write"] || flags["allowCrossStoreWrite"],
    );

    const sourceTarget = destSelection
      ? await resolveTargetContext({ context, requireWrite: false })
      : await resolveTargetContext({ context, requireWrite: !dryRun });
    await ensureProtocol(sourceTarget.root);

    const destTarget = destSelection
      ? (await resolveTarget({
          cwd: process.cwd(),
          selection: destSelection,
          storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
          requireWrite: !dryRun,
        })).target
      : sourceTarget;
    await ensureProtocol(destTarget.root);
    if (!dryRun && destTarget.root !== sourceTarget.root) {
      await ensureCrossStoreWriteAllowed({
        sourceTarget,
        destTarget,
        allowFlag: allowCrossStoreWrite,
        command: "q intake",
      });
    }

    const lockPath = !dryRun
      ? await acquireWriteLock(destTarget, destTarget.config.lock?.ttlMs)
      : null;
    try {
      await cmdIntake({
        destTarget,
        flags,
        json,
        sourceRepo: sourceTarget.root,
      });
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "transfer") {
    const destFlag = flags["dest"];
    if (destFlag === true) {
      throw new Error("Missing value for --dest.");
    }
    const destSelection =
      typeof destFlag === "string" && destFlag.trim() ? destFlag.trim() : null;
    if (!destSelection) {
      throw new Error("Missing destination --dest for q transfer.");
    }

    const sourceFlag = flags["source"];
    if (sourceFlag === true) {
      throw new Error("Missing value for --source.");
    }
    const sourceSelection =
      typeof sourceFlag === "string" && sourceFlag.trim()
        ? sourceFlag.trim()
        : context.repo ?? process.env["ATO_REPO"] ?? null;
    const dryRun = Boolean(flags["dry-run"] || flags["dryRun"]);
    const allowCrossStoreWrite = Boolean(
      flags["allow-cross-store-write"] || flags["allowCrossStoreWrite"],
    );

    const { target: sourceTarget } = await resolveTarget({
      cwd: process.cwd(),
      selection: sourceSelection,
      storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
      requireWrite: false,
    });
    const { target: destTarget } = await resolveTarget({
      cwd: process.cwd(),
      selection: destSelection,
      storeSelection: context.store ?? process.env["ATO_STORE"] ?? null,
      requireWrite: !dryRun,
    });
    await ensureProtocol(sourceTarget.root);
    await ensureProtocol(destTarget.root);
    if (!dryRun && destTarget.root !== sourceTarget.root) {
      await ensureCrossStoreWriteAllowed({
        sourceTarget,
        destTarget,
        allowFlag: allowCrossStoreWrite,
        command: "q transfer",
      });
    }

    const lockPath = !dryRun
      ? await acquireWriteLock(destTarget, destTarget.config.lock?.ttlMs)
      : null;
    try {
      await cmdTransfer({
        sourceTarget,
        destTarget,
        id: positionals[0] ?? null,
        flags,
        json,
      });
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "update") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      await cmdUpdate(target, positionals[0] ?? null, flags, args, json);
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "add") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      await cmdAdd(target, positionals.join(" "), flags, json);
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown queue subcommand." },
    });
  } else {
    writeLines([
      "Unknown queue subcommand.",
      "Usage: ato q add|update|validate|view|list|trace|intake|transfer|contract-refs",
    ]);
  }
  process.exitCode = 1;
};
