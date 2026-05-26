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
import { generateFixture } from "../../core/fixtures/index.js";
import { appendRunLog } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";
import type { FixtureResult } from "../../core/fixtures/index.js";

const HELP = [
  "Usage: ato fixture generate --file <path> --type <Name> [options]",
  "",
  "Options:",
  "  --file <path>   Path to TypeScript source file",
  "  --type <Name>   Type or interface name",
  "  --edge          Include edge-case variant",
  "",
  "Examples:",
  "  ato fixture generate --file src/core/types.ts --type QueueItem",
  "  ato fixture generate --file src/core/types.ts --type QueueItem --edge",
].join("\n");

const toJsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toJsonSafe(entry);
    }
    return result;
  }
  return value;
};

const renderOutput = (result: FixtureResult): string[] => {
  const lines = [
    `seed: ${result.seed}`,
    `type: ${result.type}`,
    `file: ${result.file}`,
    `variants: ${result.variants.length}`,
  ];
  for (const variant of result.variants) {
    lines.push("");
    lines.push(`## ${variant.name}`);
    lines.push(JSON.stringify(toJsonSafe(variant.value), null, 2));
  }
  return lines;
};

export const runFixtureCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand !== "generate") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown fixture subcommand." },
      });
    } else {
      writeLines(["Unknown fixture subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const filePath = typeof flags["file"] === "string" ? flags["file"] : null;
  const typeName = typeof flags["type"] === "string" ? flags["type"] : null;
  const includeEdge = Boolean(flags["edge"]);

  if (!filePath) throw new Error("Missing --file.");
  if (!typeName) throw new Error("Missing --type.");

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const result = await generateFixture({
      root: target.root,
      filePath,
      typeName,
      includeEdge,
    });

    await appendRunLog(target.storePath, {
      ts: new Date().toISOString(),
      kind: "fixture",
      target_id: target.id,
      commands: [],
      artifacts: [],
      summary: "fixture generate",
    });

    if (json) {
      writeJson({
        ok: true,
        seed: result.seed,
        metadata: {
          file: result.file,
          type: result.type,
          variantCount: result.variants.length,
        },
        variants: result.variants.map((variant) => ({
          name: variant.name,
          value: toJsonSafe(variant.value),
        })),
      });
    } else {
      writeLines([formatTargetLine(target), ...renderOutput(result)]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
