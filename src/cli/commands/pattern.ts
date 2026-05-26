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
} from "./shared.js";
import { appendRunLog } from "../../core/runlog.js";
import {
  readPatternItems,
  writePatternItems,
  nextPatternId,
  normalizePatternInput,
  validatePatternItem,
  applyPatternItem,
} from "../../core/learning/patterns.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato pattern add --input <json|path>",
  "  ato pattern apply --id <id> [options]",
  "",
  "Options (apply):",
  "  --id <id>           Pattern id (required)",
  "  --queue <id>        Queue id provenance",
].join("\n");

const parseDelimitedList = (value: unknown): string[] => {
  if (!value) return [];
  const raw = String(value);
  const delimiter = raw.includes("|") ? "|" : ",";
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const buildInputFromFlags = (
  flags: Record<string, string | boolean>,
): Record<string, unknown> | null => {
  const input: Record<string, unknown> = {};

  if (flags["id"]) input["id"] = String(flags["id"]).trim();
  if (flags["title"]) input["title"] = String(flags["title"]).trim();
  if (flags["kind"]) input["kind"] = String(flags["kind"]).trim();
  if (flags["summary"]) input["summary"] = String(flags["summary"]).trim();

  if (flags["steps"]) input["steps"] = parseDelimitedList(flags["steps"]);
  if (flags["signals"]) input["signals"] = parseDelimitedList(flags["signals"]);

  if (flags["frequency"] !== undefined) {
    const frequency =
      typeof flags["frequency"] === "string"
        ? Number(flags["frequency"])
        : NaN;
    if (!Number.isInteger(frequency) || frequency < 1) {
      throw new Error("--frequency must be an integer >= 1.");
    }
    input["frequency"] = frequency;
  }

  const lastSeen = flags["last-seen"] ?? flags["lastSeen"];
  if (lastSeen) input["last_seen"] = String(lastSeen).trim();

  const queueRefsRaw = flags["queue-refs"] ?? flags["queueRefs"];
  if (queueRefsRaw) input["queue_refs"] = parseDelimitedList(queueRefsRaw);

  return Object.keys(input).length ? input : null;
};

export const runPatternCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;

  if (subcommand !== "add" && subcommand !== "apply") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown pattern subcommand." },
      });
    } else {
      writeLines(["Unknown pattern subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const { flags } = parseFlags(args);
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    if (subcommand === "apply") {
      const id = typeof flags["id"] === "string" ? flags["id"] : null;
      if (!id) throw new Error("Missing --id.");
      const queueId = typeof flags["queue"] === "string" ? flags["queue"] : null;
      const now = new Date().toISOString();
      const pattern = await applyPatternItem({
        store: target.storePath,
        id,
        ...(queueId ? { queueId } : {}),
        now,
      });
      if (!pattern) {
        if (json) {
          writeJson({
            ok: false,
            code: 1,
            error: { message: "Pattern not found." },
          });
        } else {
          writeLines([formatTargetLine(target), "pattern apply: not found"]);
        }
        process.exitCode = 1;
        return;
      }

      await appendRunLog(target.storePath, {
        ts: now,
        kind: "pattern_apply",
        target_id: target.id,
        pattern_ids: [pattern.id],
        commands: [],
        artifacts: [],
        summary: "pattern apply",
        ...(queueId ? { queue_id: queueId } : {}),
      });

      if (json) {
        writeJson({ ok: true, id: pattern.id });
      } else {
        writeLines([formatTargetLine(target), `pattern apply: ${pattern.id}`]);
      }
      return;
    }

    let input: Record<string, unknown> | null = null;
    if (typeof flags["input"] === "string") {
      const parsed = await parseJsonInput(flags["input"]);
      if (!parsed.ok) throw new Error(parsed.error);
      input = parsed.value as Record<string, unknown>;
    } else {
      input = buildInputFromFlags(flags);
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(
        "Pattern input required. Use --input <json|path> or flags.",
      );
    }

    const patterns = await readPatternItems(target.storePath);
    const existingIds = new Set(patterns.map((pattern) => pattern.id));

    const inputId = input["id"];
    if (inputId && existingIds.has(String(inputId).trim())) {
      throw new Error(`pattern id '${inputId}' already exists.`);
    }

    const now = new Date().toISOString();
    const pattern = normalizePatternInput({
      input,
      fallbackId: nextPatternId(patterns),
      now,
    });

    if (existingIds.has(pattern.id)) {
      throw new Error(`pattern id '${pattern.id}' already exists.`);
    }

    const validation = await validatePatternItem(pattern);
    if (!validation.ok) {
      throw new Error(`Invalid pattern: ${validation.errors.join(", ")}`);
    }

    patterns.push(pattern);
    await writePatternItems(target.storePath, patterns);

    await appendRunLog(target.storePath, {
      ts: now,
      kind: "pattern_add",
      target_id: target.id,
      pattern_ids: [pattern.id],
      commands: [],
      artifacts: [],
      summary: "pattern add",
    });

    if (json) {
      writeJson({ ok: true, id: pattern.id });
    } else {
      writeLines([formatTargetLine(target), `pattern add: ${pattern.id}`]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
