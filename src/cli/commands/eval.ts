import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext } from "./shared.js";
import { readEvalScorecard } from "../../core/eval/ledger.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato eval scorecard",
  "",
  "Options:",
  "  --help              Show help",
].join("\n");

const writeUnknownSubcommand = (json: boolean, message: string): void => {
  if (json) {
    writeJson({ ok: false, code: 1, error: { message } });
  } else {
    writeLines([message, "", HELP]);
  }
  process.exitCode = 1;
};

export const runEvalCommand = async ({
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

  if (subcommand === "scorecard") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const scorecard = await readEvalScorecard(target.storePath);
    if (json) {
      writeJson({ ok: true, scorecard });
    } else {
      writeLines([
        formatTargetLine(target),
        `cycles: ${scorecard.cycles}`,
        `outcomes: ok=${scorecard.outcomes.ok} fail=${scorecard.outcomes.fail} inconclusive=${scorecard.outcomes.inconclusive} unknown=${scorecard.outcomes.unknown}`,
        `checks: total=${scorecard.checks.total} ok=${scorecard.checks.ok} fail=${scorecard.checks.fail} skipped=${scorecard.checks.skipped} unknown=${scorecard.checks.unknown}`,
        scorecard.last_cycle_id ? `last cycle: ${scorecard.last_cycle_id}` : null,
      ]);
    }
    return;
  }

  writeUnknownSubcommand(json, "Unknown eval subcommand.");
};
