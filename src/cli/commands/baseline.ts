import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext, ensureProtocol } from "./shared.js";
import { verifyBaselineRegistry } from "../../core/blocks/baseline.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato baseline verify --tag <baseline-tag>",
  "",
  "Examples:",
  "  ato baseline verify --tag baseline-main --json",
].join("\n");

const BASELINE_VERIFY_SCHEMA = "baseline-verify.v1";

export const runBaselineCommand = async ({
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

  if (subcommand !== "verify") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown baseline subcommand." } });
    } else {
      writeLines(["Unknown baseline subcommand.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const tag = typeof flags["tag"] === "string" ? flags["tag"] : "";
  const target = await resolveTargetContext({ context, requireWrite: false });
  await ensureProtocol(target.root);

  const result = await verifyBaselineRegistry({
    root: target.root,
    store: target.storePath,
    tag,
  });

  const payload = {
    schema_version: BASELINE_VERIFY_SCHEMA,
    ...result,
  };

  if (json) {
    writeJson(payload);
  } else {
    const lines = [
      formatTargetLine(target),
      `baseline: ${result.tag || "unknown"}`,
      `registry: ${result.registry_path}`,
      `status: ${result.ok ? "ok" : "fail"}`,
      ...result.errors.map((error) => `- ${error.kind}: ${error.message}`),
    ];
    if (result.guidance.length) {
      lines.push("guidance:");
      lines.push(...result.guidance.map((entry) => `- ${entry}`));
    }
    writeLines(lines);
  }

  if (!result.ok) {
    process.exitCode = 3;
  }
};
