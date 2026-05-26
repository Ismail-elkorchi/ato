import { parseFlags, writeJson, writeLines } from "../utils.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato {{slug}} [options]",
  "",
  "Summary:",
  "  {{summary}}",
].join("\n");

export const run{{pascalName}}Command = async ({
  args,
  context,
}: {
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (json) {
    writeJson({ ok: true, message: "{{summary}}" });
    return;
  }

  writeLines(["{{summary}}"]);
};
