import path from "node:path";

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
import { scaffoldFromSpec } from "../../core/scaffold/index.js";
import { appendRunLog } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";
import type { ScaffoldSpec } from "../../core/scaffold/index.js";

const HELP = [
  "Usage: ato scaffold --input <json|path> [--dry-run]",
  "",
  "Options:",
  "  --input <json|path>  Scaffold spec as JSON or a JSON file path",
  "  --dry-run           Preview planned outputs without writing files",
  "",
  "Example:",
  '  ato scaffold --input \'{"name":"example","summary":"New command"}\'',
  "  ato scaffold --input scaffold.json --dry-run",
].join("\n");

export const runScaffoldCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const hasFlagSubcommand = Boolean(subcommand && subcommand.startsWith("-"));
  const effectiveSubcommand = hasFlagSubcommand ? null : subcommand;
  const effectiveArgs =
    hasFlagSubcommand && subcommand ? [subcommand, ...args] : args;
  const { flags } = parseFlags(effectiveArgs);

  if (effectiveSubcommand) {
    writeLines(["Unknown scaffold subcommand.", HELP]);
    process.exitCode = 1;
    return;
  }

  if (flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (typeof flags["input"] !== "string") {
    throw new Error("Missing required --input.");
  }

  const dryRun = Boolean(flags["dry-run"]);
  const target = await resolveTargetContext({
    context,
    requireWrite: !dryRun,
  });
  if (!dryRun) {
    await ensureProtocol(target.root);
  }
  const lockPath = !dryRun
    ? await acquireWriteLock(target, target.config.lock?.ttlMs)
    : null;

  try {
    const parsed = await parseJsonInput(flags["input"]);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const spec = parsed.value as ScaffoldSpec;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("Scaffold spec must be a JSON object.");
    }

    const templatesRoot = path.join(target.root, "templates", "scaffold");
    const result = await scaffoldFromSpec({
      root: target.root,
      spec,
      templatesRoot,
      dryRun,
    });

    if (!dryRun) {
      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "scaffold",
        target_id: target.id,
        commands: [],
        artifacts: [],
        summary: "scaffold",
      });
    }

    if (json) {
      writeJson({
        ok: true,
        dry_run: dryRun,
        outputs: result.outputs,
        plan: result.plan,
      });
    } else {
      const lines = [
        formatTargetLine(target),
        dryRun ? "scaffold: dry-run" : "scaffold:",
        ...result.plan.map(
          (output) =>
            `- ${output.kind}: ${output.path} (template: ${output.template})`,
        ),
      ];
      writeLines(lines);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
