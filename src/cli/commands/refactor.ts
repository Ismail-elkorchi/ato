import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  planRenameRefactor,
  applyRenamePlan,
  createRollbackBundle,
  loadRollbackBundle,
  applyRollbackBundle,
} from "../../core/refactor/rename.js";
import type { ApiDelta, RefactorRenameFile } from "../../core/refactor/rename.js";
import { appendRunLog } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato refactor rename --from <name> --to <name> [options]",
  "  ato refactor rollback --id <rollback-id>",
  "",
  "Options (rename):",
  "  --from <name>     Symbol to rename (required)",
  "  --to <name>       New symbol name (required)",
  "  --paths <a,b,c>   Comma-delimited roots/files (default: src,packages)",
  "  --apply           Apply changes (default: preview only)",
  "",
  "Options (rollback):",
  "  --id <rollback-id>   Rollback bundle id",
  "",
  "Examples:",
  "  ato refactor rename --from OldName --to NewName --paths src,packages",
  "  ato refactor rename --from oldName --to newName --apply",
  "  ato refactor rollback --id ab12cd34ef56",
].join("\n");

const formatApiDelta = (apiDelta: ApiDelta): string[] => {
  const lines = ["API changes:"];
  if (!apiDelta.added.length && !apiDelta.removed.length) {
    lines.push("  (none)");
    return lines;
  }
  if (apiDelta.added.length) {
    lines.push("  added:");
    for (const entry of apiDelta.added) {
      lines.push(`    + ${entry.path}: ${entry.name}`);
    }
  }
  if (apiDelta.removed.length) {
    lines.push("  removed:");
    for (const entry of apiDelta.removed) {
      lines.push(`    - ${entry.path}: ${entry.name}`);
    }
  }
  return lines;
};

const formatDiff = (files: RefactorRenameFile[]): string[] => {
  const lines = ["Diff:"];
  let emitted = 0;
  for (const file of files) {
    if (!file.diff.length) continue;
    lines.push(`@@ ${file.path}`);
    for (const diffLine of file.diff) {
      lines.push(` ${diffLine}`);
      emitted += 1;
    }
  }
  if (emitted === 0) {
    lines.push("  (none)");
  }
  return lines;
};

export const runRefactorCommand = async ({
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

  if (subcommand !== "rename" && subcommand !== "rollback") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown refactor subcommand." },
      });
    } else {
      writeLines(["Unknown refactor subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
  try {
    if (subcommand === "rename") {
      const from = typeof flags["from"] === "string" ? flags["from"] : null;
      const to = typeof flags["to"] === "string" ? flags["to"] : null;
      if (!from) throw new Error("Missing --from.");
      if (!to) throw new Error("Missing --to.");
      if (from === to) throw new Error("--from and --to must differ.");

      const rawPaths =
        typeof flags["paths"] === "string" ? flags["paths"] : null;
      const targetPaths = rawPaths
        ? rawPaths
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : ["src", "packages"];

      const apply = Boolean(flags["apply"]);
      const plan = await planRenameRefactor({
        root: target.root,
        paths: targetPaths,
        from,
        to,
      });
      const hasChanges = plan.files.length > 0;
      let rollback: { id: string; path: string } | null = null;

      if (apply && hasChanges) {
        const bundleResult = await createRollbackBundle({
          store: target.storePath,
          plan,
        });
        await applyRenamePlan({ root: target.root, plan });
        rollback = {
          id: bundleResult.bundle.id,
          path: bundleResult.bundlePath,
        };
        await appendRunLog(target.storePath, {
          ts: new Date().toISOString(),
          kind: "refactor",
          target_id: target.id,
          mode: "apply",
          artifacts: [bundleResult.bundlePath],
          summary: `refactor rename ${bundleResult.bundle.id}`,
        });
      }

      if (json) {
        writeJson({
          ok: true,
          applied: apply && hasChanges,
          from,
          to,
          rollbackId: rollback?.id ?? null,
          rollbackPath: rollback?.path ?? null,
          impactedFiles: plan.impactedFiles,
          apiDelta: plan.apiDelta,
          files: plan.files.map((entry) => ({
            path: entry.path,
            changeCount: entry.changes.length,
            changes: entry.changes.map((change) => ({
              line: change.line,
              column: change.column,
              before: change.before,
              after: change.after,
            })),
            diff: entry.diff,
          })),
          summary: plan.summary,
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `refactor rename: ${apply ? "applied" : "preview"}`,
          `from: ${from}`,
          `to: ${to}`,
          `files: ${plan.summary.filesChanged}`,
          `replacements: ${plan.summary.replacements}`,
        ];
        if (rollback) {
          lines.push(`rollback: ${rollback.id}`);
          lines.push(`rollback bundle: ${rollback.path}`);
        }
        lines.push("", ...formatApiDelta(plan.apiDelta), "");
        lines.push(...formatDiff(plan.files));
        if (!hasChanges) {
          lines.push("", "No changes detected.");
        }
        writeLines(lines);
      }
      return;
    }

    const rollbackId = typeof flags["id"] === "string" ? flags["id"] : null;
    if (!rollbackId) throw new Error("Missing --id.");
    const { bundle, bundlePath } = await loadRollbackBundle({
      store: target.storePath,
      id: rollbackId,
    });
    if (bundle.id !== rollbackId) {
      throw new Error(`Rollback bundle id mismatch: expected ${rollbackId}.`);
    }
    const restored = await applyRollbackBundle({
      root: target.root,
      bundle,
    });
    await appendRunLog(target.storePath, {
      ts: new Date().toISOString(),
      kind: "refactor",
      target_id: target.id,
      mode: "rollback",
      artifacts: [bundlePath],
      summary: `refactor rollback ${bundle.id}`,
    });

    if (json) {
      writeJson({
        ok: true,
        rollbackId: bundle.id,
        bundlePath,
        impactedFiles: bundle.files.map((file) => file.path),
        apiDelta: bundle.apiDelta,
        restoredFiles: restored,
        summary: bundle.summary,
      });
    } else {
      const lines = [
        formatTargetLine(target),
        "refactor rollback: applied",
        `rollback: ${bundle.id}`,
        `bundle: ${bundlePath}`,
        `files: ${bundle.files.length}`,
        "",
      ];
      for (const entry of restored) {
        lines.push(
          `- ${entry.path}${entry.matched ? "" : " (content mismatch)"}`,
        );
      }
      lines.push("", ...formatApiDelta(bundle.apiDelta));
      writeLines(lines);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
