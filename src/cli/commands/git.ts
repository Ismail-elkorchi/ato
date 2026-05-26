import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext, ensureProtocol } from "./shared.js";
import { gatherGitStatus } from "../../core/git/status.js";
import { gatherGitLocks } from "../../core/git/locks.js";
import {
  buildGitCleanPlan,
  buildGitCommitPlan,
  buildGitRestorePlan,
  buildGitStashPlan,
} from "../../core/git/plan.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato git status|locks|plan clean|plan commit|plan stash|plan restore [options]",
  "",
  "Subcommands:",
  "  status              Read-only deterministic git working tree status",
  "  locks               Read-only lock status for .ato and .git domains",
  "  plan clean          Read-only deterministic clean-tree action menu",
  "  plan commit         Read-only deterministic commit-workflow action menu",
  "  plan stash          Read-only deterministic stash-workflow action menu",
  "  plan restore        Read-only deterministic restore-workflow action menu",
  "",
  "Plan options:",
  "  --max-level <1|2|3> Include actions up to this danger level (default: 2)",
  "  --include-level3    Include severe destructive actions in plan output (still read-only)",
  "",
  "Examples:",
  "  ato git status --json",
  "  ato git locks --json",
  "  ato git plan clean --json",
  "  ato git plan clean --max-level 3 --json",
  "  ato git plan clean --include-level3 --json",
  "  ato git plan commit --json",
  "  ato git plan stash --json",
  "  ato git plan restore --json",
].join("\n");

const gatherLocksForTarget = async ({
  root,
  store,
  ttlMs,
}: {
  root: string;
  store: string;
  ttlMs: number | undefined;
}) => {
  const locksInput: { root: string; store: string; ttlMs?: number } = {
    root,
    store,
  };
  if (typeof ttlMs === "number") {
    locksInput.ttlMs = ttlMs;
  }
  return gatherGitLocks(locksInput);
};

const parseMaxLevel = (
  value: string | boolean | undefined,
): 1 | 2 | 3 | null => {
  if (typeof value !== "string") return null;
  if (value === "1") return 1;
  if (value === "2") return 2;
  if (value === "3") return 3;
  return null;
};

export const runGitCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags, positionals } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: false });
  await ensureProtocol(target.root);

  if (subcommand === "status") {
    const status = gatherGitStatus(target.root);
    if (json) {
      writeJson({
        ok: true,
        schema_version: "git-status.v2",
        ...status,
      });
    } else {
      writeLines([
        formatTargetLine(target),
        `dirty: ${status.dirty ? "yes" : "no"}`,
        `optional locks: ${status.optional_locks.env_var}=${status.optional_locks.value}`,
        ...(status.status_sb ? [`status:\n${status.status_sb}`] : []),
        ...(status.tracked_paths.length
          ? [`tracked paths: ${status.tracked_paths.join(", ")}`]
          : []),
        ...(status.untracked_paths.length
          ? [`untracked paths: ${status.untracked_paths.join(", ")}`]
          : []),
        ...(status.staged_paths.length
          ? [`staged paths: ${status.staged_paths.join(", ")}`]
          : []),
        ...(status.unstaged_paths.length
          ? [`unstaged paths: ${status.unstaged_paths.join(", ")}`]
          : []),
      ]);
    }
    return;
  }

  if (subcommand === "locks") {
    const snapshot = await gatherLocksForTarget({
      root: target.root,
      store: target.storePath,
      ttlMs: target.config.lock?.ttlMs,
    });
    if (json) {
      writeJson({
        ok: true,
        schema_version: "git-locks.v1",
        ...snapshot,
      });
    } else {
      writeLines([
        formatTargetLine(target),
        `ato lock: ${snapshot.ato_lock.exists ? "present" : "none"} (${snapshot.ato_lock.path})`,
        `git index lock: ${snapshot.git_lock.exists ? "present" : "none"} (${snapshot.git_lock.path})`,
      ]);
    }
    return;
  }

  if (subcommand === "plan") {
    const action = positionals[0] ?? null;
    if (
      action !== "clean" &&
      action !== "commit" &&
      action !== "stash" &&
      action !== "restore"
    ) {
      if (json) {
        writeJson({ ok: false, code: 1, error: { message: "Unknown git plan action." } });
      } else {
        writeLines(["Unknown git plan action.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const status = gatherGitStatus(target.root);
    const locks = await gatherLocksForTarget({
      root: target.root,
      store: target.storePath,
      ttlMs: target.config.lock?.ttlMs,
    });
    const parsedMaxLevel = parseMaxLevel(flags["max-level"]);
    if (flags["max-level"] !== undefined && parsedMaxLevel === null) {
      if (json) {
        writeJson({
          ok: false,
          code: 1,
          error: { message: "Invalid --max-level. Expected one of: 1, 2, 3." },
        });
      } else {
        writeLines(["Invalid --max-level. Expected one of: 1, 2, 3.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }
    const includeLevel3 = flags["include-level3"] === true;
    const maxLevel = includeLevel3 ? 3 : (parsedMaxLevel ?? 2);
    const plan =
      action === "clean"
        ? buildGitCleanPlan({
            status,
            locks,
            maxLevel,
          })
        : action === "commit"
          ? buildGitCommitPlan({
              status,
              locks,
              maxLevel,
            })
          : action === "stash"
            ? buildGitStashPlan({
                status,
                locks,
                maxLevel,
              })
            : buildGitRestorePlan({
                status,
                locks,
                maxLevel,
              });

    if (json) {
      writeJson({
        ok: true,
        ...plan,
      });
    } else {
      writeLines([
        formatTargetLine(target),
        `mode: ${plan.mode}`,
        `dirty: ${plan.dirty ? "yes" : "no"}`,
        `tracked: ${plan.tracked_paths.length}`,
        `untracked: ${plan.untracked_paths.length}`,
        `staged: ${plan.staged_paths.length}`,
        `unstaged: ${plan.unstaged_paths.length}`,
        `max level: ${plan.max_level}`,
        `included levels: ${plan.included_levels.join(",")}`,
        `level3 included: ${plan.level3_included ? "yes" : "no"}`,
        "actions:",
        ...plan.actions.map(
          (entry) =>
            `- [L${entry.danger_level}] ${entry.id} (${entry.danger}) applies=${entry.applies ? "yes" : "no"} default=${entry.default_recommendation}`,
        ),
      ]);
    }
    return;
  }

  if (json) {
    writeJson({ ok: false, code: 1, error: { message: "Unknown git subcommand." } });
  } else {
    writeLines(["Unknown git subcommand.", "", HELP]);
  }
  process.exitCode = 1;
};
