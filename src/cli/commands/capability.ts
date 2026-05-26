import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  CAPABILITIES,
  CAPABILITY_VERSION,
} from "../../core/capability/manifest.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato capability list|explain [options]",
  "",
  "Examples:",
  "  ato capability list --json",
  "  ato capability explain q.add",
].join("\n");

const sortEntries = () =>
  [...CAPABILITIES].sort((a, b) => a.id.localeCompare(b.id));

export const runCapabilityCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { positionals } = parseFlags(args);

  if (!subcommand) {
    writeLines([HELP]);
    return;
  }

  if (subcommand === "list") {
    const entries = sortEntries();
    if (context.json) {
      writeJson({ ok: true, version: CAPABILITY_VERSION, entries });
    } else {
      writeLines([
        `capabilities: ${entries.length}`,
        ...entries.map((entry) => `- ${entry.id}: ${entry.summary}`),
      ]);
    }
    return;
  }

  if (subcommand === "explain") {
    const id = positionals[0] ?? null;
    if (!id) {
      throw new Error("Usage: ato capability explain <id>");
    }
    const entry = CAPABILITIES.find((item) => item.id === id) ?? null;
    if (!entry) {
      const error = new Error(`Unknown capability id '${id}'.`);
      (error as Error & { code?: number }).code = 2;
      throw error;
    }
    if (context.json) {
      writeJson({ ok: true, version: CAPABILITY_VERSION, entry });
    } else {
      const flags = entry.flags.length
        ? entry.flags.map((flag) => {
            const parts = [
              flag.name,
              flag.type,
              flag.required ? "required" : null,
              flag.default !== undefined ? `default=${flag.default}` : null,
            ].filter(Boolean);
            return `- ${parts.join(" ")}`;
          })
        : ["- none"];
      writeLines([
        `id: ${entry.id}`,
        `command: ${entry.command}${entry.subcommand ? ` ${entry.subcommand}` : ""}`,
        `summary: ${entry.summary}`,
        `target: required=${entry.target.required} write=${entry.target.write}`,
        `side effects: read=${entry.sideEffects.read} write=${entry.sideEffects.write} network=${entry.sideEffects.network}`,
        "flags:",
        ...flags,
        entry.preconditions.length ? "preconditions:" : null,
        ...entry.preconditions.map((item) => `- ${item}`),
      ]);
    }
    return;
  }

  if (context.json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown capability subcommand." },
    });
  } else {
    writeLines(["Unknown capability subcommand.", HELP]);
  }
  process.exitCode = 1;
};
