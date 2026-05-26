import { parseFlags, writeJson, writeLines } from "../utils.js";
import { resolveTargetContext } from "./shared.js";
import { checkProtocolCompatibility } from "../../core/protocol.js";
import type { CommandContext } from "../types.js";

const HELP_TOKENS = new Set(["--help", "-h", "help"]);

export const runProtocolCommand = async ({
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
  const helpRequested =
    Boolean(flags["help"]) ||
    HELP_TOKENS.has((subcommand ?? "").toLowerCase());
  if (helpRequested) {
    writeLines(["Usage: ato protocol check [options]"]);
    return;
  }

  if (subcommand !== "check") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown protocol subcommand." },
      });
    } else {
      writeLines(["Unknown protocol subcommand.", "Usage: ato protocol check"]);
    }
    process.exitCode = 1;
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: false });
  const result = await checkProtocolCompatibility(target.root);

  if (json) {
    writeJson(result);
  } else {
    const lines = [
      `protocol: ${result.ok ? "ok" : "mismatch"}`,
      `repo protocol: ${result.meta.protocolVersion ?? "unknown"}`,
      `min cli: ${result.meta.minCliVersion ?? "unknown"}`,
      `cli version: ${result.meta.cliVersion}`,
    ];
    if (!result.ok) {
      lines.push("errors:");
      for (const error of result.errors) {
        lines.push(`- ${error.kind}: ${error.message}`);
      }
    }
    writeLines(lines);
  }

  if (!result.ok) {
    process.exitCode = 5;
  }
};
