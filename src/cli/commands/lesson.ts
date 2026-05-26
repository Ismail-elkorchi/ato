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
  readLessonItems,
  writeLessonItems,
  nextLessonId,
  normalizeLessonInput,
  validateLessonItem,
} from "../../core/learning/lessons.js";
import type { CommandContext } from "../types.js";

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
  if (flags["tool"]) input["tool"] = String(flags["tool"]).trim();
  if (flags["rule"]) input["rule"] = String(flags["rule"]).trim();
  if (flags["pattern"]) input["pattern"] = String(flags["pattern"]).trim();
  if (flags["prevention"]) {
    input["prevention"] = String(flags["prevention"]).trim();
  }
  if (flags["notes"]) input["notes"] = String(flags["notes"]).trim();

  if (flags["frequency"] !== undefined) {
    const frequency =
      typeof flags["frequency"] === "string" ? Number(flags["frequency"]) : NaN;
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

export const runLessonCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;

  if (subcommand !== "add") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown lesson subcommand." },
      });
    } else {
      writeLines([
        "Unknown lesson subcommand.",
        "Usage: ato lesson add --input <json|path>",
      ]);
    }
    process.exitCode = 1;
    return;
  }

  const { flags } = parseFlags(args);
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
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
        "Lesson input required. Use --input <json|path> or flags.",
      );
    }

    const lessons = await readLessonItems(target.storePath);
    const existingIds = new Set(lessons.map((lesson) => lesson.id));

    const inputId = input["id"];
    if (inputId && existingIds.has(String(inputId).trim())) {
      throw new Error(`lesson id '${inputId}' already exists.`);
    }

    const now = new Date().toISOString();
    const lesson = normalizeLessonInput({
      input,
      fallbackId: nextLessonId(lessons),
      now,
    });

    if (existingIds.has(lesson.id)) {
      throw new Error(`lesson id '${lesson.id}' already exists.`);
    }

    const validation = await validateLessonItem(lesson);
    if (!validation.ok) {
      throw new Error(`Invalid lesson: ${validation.errors.join(", ")}`);
    }

    lessons.push(lesson);
    await writeLessonItems(target.storePath, lessons);

    await appendRunLog(target.storePath, {
      ts: now,
      kind: "lesson_add",
      target_id: target.id,
      lesson_ids: [lesson.id],
      commands: [],
      artifacts: [],
      summary: "lesson add",
    });

    if (json) {
      writeJson({ ok: true, id: lesson.id });
    } else {
      writeLines([formatTargetLine(target), `lesson add: ${lesson.id}`]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
