import type { GitLocksSnapshot } from "./locks.js";
import type { GitStatusSnapshot } from "./status.js";

export type DangerLevel = 1 | 2 | 3;

export type GitPlanAction = {
  id: string;
  danger_level: DangerLevel;
  danger: "mild" | "moderate" | "severe";
  applies: boolean;
  default_recommendation: "recommended" | "optional" | "refuse";
  preconditions: string[];
  command: string;
  summary: string;
  confirmation_kind: "none" | "force" | "confirm_token";
  explain: string;
};

type GitPlanBaseSnapshot = {
  mode: "read_only";
  dirty: boolean;
  tracked_paths: string[];
  untracked_paths: string[];
  staged_paths: string[];
  unstaged_paths: string[];
  lock_state: {
    ato_lock: boolean;
    git_index_lock: boolean;
  };
  max_level: DangerLevel;
  included_levels: DangerLevel[];
  level3_available: boolean;
  level3_included: boolean;
};

export type GitPlanCleanSnapshot = GitPlanBaseSnapshot & {
  schema_version: "git-plan-clean.v1";
  actions: GitPlanAction[];
};

export type GitPlanCommitSnapshot = GitPlanBaseSnapshot & {
  schema_version: "git-plan-commit.v1";
  actions: GitPlanAction[];
};

export type GitPlanStashSnapshot = GitPlanBaseSnapshot & {
  schema_version: "git-plan-stash.v1";
  actions: GitPlanAction[];
};

export type GitPlanRestoreSnapshot = GitPlanBaseSnapshot & {
  schema_version: "git-plan-restore.v1";
  actions: GitPlanAction[];
};

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b));

const includedLevels = (maxLevel: DangerLevel): DangerLevel[] =>
  maxLevel === 1 ? [1] : maxLevel === 2 ? [1, 2] : [1, 2, 3];

const filterByMaxLevel = (
  actions: GitPlanAction[],
  maxLevel: DangerLevel,
): GitPlanAction[] => actions.filter((entry) => entry.danger_level <= maxLevel);

const buildBaseSnapshot = ({
  status,
  locks,
  maxLevel,
  level3Available,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
  maxLevel: DangerLevel;
  level3Available: boolean;
}): GitPlanBaseSnapshot => ({
  mode: "read_only",
  dirty: status.dirty,
  tracked_paths: uniqueSorted(status.tracked_paths),
  untracked_paths: uniqueSorted(status.untracked_paths),
  staged_paths: uniqueSorted(status.staged_paths),
  unstaged_paths: uniqueSorted(status.unstaged_paths),
  lock_state: {
    ato_lock: locks.ato_lock.exists,
    git_index_lock: locks.git_lock.exists,
  },
  max_level: maxLevel,
  included_levels: includedLevels(maxLevel),
  level3_available: level3Available,
  level3_included: maxLevel >= 3,
});

const buildCleanActions = ({
  status,
  locks,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
}): GitPlanAction[] => {
  const hasTracked = status.tracked_paths.length > 0;
  const hasUntracked = status.untracked_paths.length > 0;
  const lockContention = locks.ato_lock.exists || locks.git_lock.exists;

  return [
    {
      id: "capture_preflight",
      danger_level: 1,
      danger: "mild",
      applies: true,
      default_recommendation: "recommended",
      preconditions: ["none"],
      command: "ato git status --json && ato git locks --json",
      summary: "Capture deterministic preflight state before any git write.",
      confirmation_kind: "none",
      explain: "Read-only status capture does not require confirmation.",
    },
    {
      id: "commit_tracked",
      danger_level: 2,
      danger: "moderate",
      applies: hasTracked && !lockContention,
      default_recommendation: hasTracked && !lockContention ? "recommended" : "optional",
      preconditions: [
        "tracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git add -- <tracked-paths> && git commit -m \"<message>\"",
      summary: "Commit tracked edits to reach a clean tree safely.",
      confirmation_kind: "force",
      explain: "Write-side commit execution should require explicit force-style opt-in.",
    },
    {
      id: "stash_tracked",
      danger_level: 2,
      danger: "moderate",
      applies: hasTracked && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "tracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push -- <tracked-paths>",
      summary: "Temporarily stash tracked edits when a commit is not desired.",
      confirmation_kind: "force",
      explain: "Write-side stash execution should require explicit force-style opt-in.",
    },
    {
      id: "restore_tracked",
      danger_level: 2,
      danger: "moderate",
      applies: hasTracked && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "tracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git restore --staged --worktree -- <tracked-paths>",
      summary: "Discard tracked edits intentionally after review.",
      confirmation_kind: "confirm_token",
      explain: "Discarding tracked edits should require a stronger confirmation token.",
    },
    {
      id: "review_untracked",
      danger_level: 1,
      danger: "mild",
      applies: hasUntracked,
      default_recommendation: hasUntracked ? "recommended" : "optional",
      preconditions: ["untracked_paths not empty"],
      command: "git status --porcelain=v1",
      summary: "Review untracked files explicitly before cleanup choices.",
      confirmation_kind: "none",
      explain: "Read-only review does not require confirmation.",
    },
    {
      id: "preview_untracked_clean",
      danger_level: 2,
      danger: "moderate",
      applies: hasUntracked && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "untracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -nd",
      summary: "Preview untracked removal candidates using dry-run output.",
      confirmation_kind: "none",
      explain: "Dry-run preview does not mutate state.",
    },
    {
      id: "clean_untracked_force",
      danger_level: 3,
      danger: "severe",
      applies: hasUntracked && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "explicit operator confirmation",
        "untracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -fd",
      summary: "Destructive untracked deletion; keep refused by default.",
      confirmation_kind: "confirm_token",
      explain: "Destructive deletion requires a strong confirmation token.",
    },
  ];
};

const buildCommitActions = ({
  status,
  locks,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
}): GitPlanAction[] => {
  const hasStaged = status.staged_paths.length > 0;
  const hasUnstaged = status.unstaged_paths.length > 0;
  const hasUntracked = status.untracked_paths.length > 0;
  const hasMixed = hasStaged && hasUnstaged;
  const lockContention = locks.ato_lock.exists || locks.git_lock.exists;

  return [
    {
      id: "capture_preflight",
      danger_level: 1,
      danger: "mild",
      applies: true,
      default_recommendation: "recommended",
      preconditions: ["none"],
      command: "ato git status --json && ato git locks --json",
      summary: "Capture deterministic preflight state before any git write.",
      confirmation_kind: "none",
      explain: "Read-only status capture does not require confirmation.",
    },
    {
      id: "review_commit_surface",
      danger_level: 1,
      danger: "mild",
      applies: status.dirty,
      default_recommendation: "recommended",
      preconditions: ["dirty tree present"],
      command: "git status --short --branch",
      summary: "Review staged, unstaged, and untracked state before commit planning.",
      confirmation_kind: "none",
      explain: "Read-only review does not require confirmation.",
    },
    {
      id: "stage_unstaged",
      danger_level: 2,
      danger: "moderate",
      applies: hasUnstaged && !lockContention,
      default_recommendation: hasUnstaged && !lockContention ? "recommended" : "optional",
      preconditions: [
        "unstaged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git add -- <unstaged-paths>",
      summary: "Stage unstaged tracked edits for the next commit.",
      confirmation_kind: "force",
      explain: "Index mutations should require explicit force-style opt-in.",
    },
    {
      id: "commit_staged",
      danger_level: 2,
      danger: "moderate",
      applies: hasStaged && !lockContention,
      default_recommendation: hasStaged && !lockContention ? "recommended" : "optional",
      preconditions: [
        "staged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git commit -m \"<message>\"",
      summary: "Commit staged changes with an explicit message.",
      confirmation_kind: "force",
      explain: "History writes should require explicit force-style opt-in.",
    },
    {
      id: "split_mixed_state",
      danger_level: 2,
      danger: "moderate",
      applies: hasMixed && !lockContention,
      default_recommendation: hasMixed && !lockContention ? "optional" : "refuse",
      preconditions: [
        "both staged_paths and unstaged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git add -p",
      summary: "Split mixed staged/unstaged state before committing.",
      confirmation_kind: "force",
      explain: "Interactive staging intent should require explicit operator opt-in.",
    },
    {
      id: "stash_untracked_before_commit",
      danger_level: 2,
      danger: "moderate",
      applies: hasUntracked && !lockContention,
      default_recommendation: hasUntracked && !lockContention ? "optional" : "refuse",
      preconditions: [
        "untracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push --include-untracked",
      summary: "Temporarily stash untracked files when commit scope must stay narrow.",
      confirmation_kind: "force",
      explain: "Stash writes should require explicit force-style opt-in.",
    },
    {
      id: "discard_unstaged_force",
      danger_level: 3,
      danger: "severe",
      applies: hasUnstaged && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "unstaged_paths not empty",
        "explicit operator confirmation",
        "no active .ato/.git lock contention",
      ],
      command: "git restore --worktree -- <unstaged-paths>",
      summary: "Destructive discard of unstaged tracked edits.",
      confirmation_kind: "confirm_token",
      explain: "Discarding worktree edits requires a strong confirmation token.",
    },
    {
      id: "clean_untracked_force",
      danger_level: 3,
      danger: "severe",
      applies: hasUntracked && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "untracked_paths not empty",
        "explicit operator confirmation",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -fd",
      summary: "Destructive untracked deletion for final tree cleanup.",
      confirmation_kind: "confirm_token",
      explain: "Destructive deletion requires a strong confirmation token.",
    },
  ];
};

const buildStashActions = ({
  status,
  locks,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
}): GitPlanAction[] => {
  const hasTracked = status.tracked_paths.length > 0;
  const hasStaged = status.staged_paths.length > 0;
  const hasUnstaged = status.unstaged_paths.length > 0;
  const hasUntracked = status.untracked_paths.length > 0;
  const lockContention = locks.ato_lock.exists || locks.git_lock.exists;

  return [
    {
      id: "capture_preflight",
      danger_level: 1,
      danger: "mild",
      applies: true,
      default_recommendation: "recommended",
      preconditions: ["none"],
      command: "ato git status --json && ato git locks --json",
      summary: "Capture deterministic preflight state before any git write.",
      confirmation_kind: "none",
      explain: "Read-only status capture does not require confirmation.",
    },
    {
      id: "review_stash_surface",
      danger_level: 1,
      danger: "mild",
      applies: status.dirty,
      default_recommendation: "recommended",
      preconditions: ["dirty tree present"],
      command: "git status --short --branch",
      summary: "Review staged, unstaged, and untracked state before stash planning.",
      confirmation_kind: "none",
      explain: "Read-only review does not require confirmation.",
    },
    {
      id: "stash_tracked",
      danger_level: 2,
      danger: "moderate",
      applies: hasTracked && !lockContention,
      default_recommendation: hasTracked && !lockContention ? "recommended" : "optional",
      preconditions: [
        "tracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push -- <tracked-paths>",
      summary: "Stash tracked modifications while keeping untracked files untouched.",
      confirmation_kind: "force",
      explain: "Stash writes should require explicit force-style opt-in.",
    },
    {
      id: "stash_staged_only",
      danger_level: 2,
      danger: "moderate",
      applies: hasStaged && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "staged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push --staged",
      summary: "Stash only staged changes when unstaged context should remain.",
      confirmation_kind: "force",
      explain: "Selective stash writes should require explicit force-style opt-in.",
    },
    {
      id: "stash_include_untracked",
      danger_level: 2,
      danger: "moderate",
      applies: hasUntracked && !lockContention,
      default_recommendation: hasUntracked && !lockContention ? "recommended" : "optional",
      preconditions: [
        "untracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push --include-untracked",
      summary: "Stash untracked files explicitly when untracked cleanup is required.",
      confirmation_kind: "force",
      explain: "Including untracked files in stash should require explicit force-style opt-in.",
    },
    {
      id: "stash_keep_index",
      danger_level: 2,
      danger: "moderate",
      applies: hasUnstaged && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "unstaged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push --keep-index",
      summary: "Stash unstaged changes while preserving staged intent.",
      confirmation_kind: "force",
      explain: "Selective stash writes should require explicit force-style opt-in.",
    },
    {
      id: "clean_untracked_force",
      danger_level: 3,
      danger: "severe",
      applies: hasUntracked && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "untracked_paths not empty",
        "explicit operator confirmation",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -fd",
      summary: "Destructive untracked deletion if stashing is intentionally skipped.",
      confirmation_kind: "confirm_token",
      explain: "Destructive cleanup requires a strong confirmation token.",
    },
  ];
};

const buildRestoreActions = ({
  status,
  locks,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
}): GitPlanAction[] => {
  const hasTracked = status.tracked_paths.length > 0;
  const hasStaged = status.staged_paths.length > 0;
  const hasUnstaged = status.unstaged_paths.length > 0;
  const hasUntracked = status.untracked_paths.length > 0;
  const lockContention = locks.ato_lock.exists || locks.git_lock.exists;

  return [
    {
      id: "capture_preflight",
      danger_level: 1,
      danger: "mild",
      applies: true,
      default_recommendation: "recommended",
      preconditions: ["none"],
      command: "ato git status --json && ato git locks --json",
      summary: "Capture deterministic preflight state before any git write.",
      confirmation_kind: "none",
      explain: "Read-only status capture does not require confirmation.",
    },
    {
      id: "review_restore_surface",
      danger_level: 1,
      danger: "mild",
      applies: status.dirty,
      default_recommendation: "recommended",
      preconditions: ["dirty tree present"],
      command: "git status --short --branch",
      summary: "Review tracked, staged, and untracked state before restore planning.",
      confirmation_kind: "none",
      explain: "Read-only review does not require confirmation.",
    },
    {
      id: "unstage_staged_changes",
      danger_level: 2,
      danger: "moderate",
      applies: hasStaged && !lockContention,
      default_recommendation: hasStaged && !lockContention ? "recommended" : "optional",
      preconditions: [
        "staged_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git restore --staged -- <staged-paths>",
      summary: "Move staged changes back to working tree before further decisions.",
      confirmation_kind: "force",
      explain: "Index mutations should require explicit force-style opt-in.",
    },
    {
      id: "stash_before_restore",
      danger_level: 2,
      danger: "moderate",
      applies: hasTracked && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "tracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git stash push --include-untracked",
      summary: "Stash a safety snapshot before destructive restore operations.",
      confirmation_kind: "force",
      explain: "Stash writes should require explicit force-style opt-in.",
    },
    {
      id: "preview_untracked_cleanup",
      danger_level: 2,
      danger: "moderate",
      applies: hasUntracked && !lockContention,
      default_recommendation: "optional",
      preconditions: [
        "untracked_paths not empty",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -nd",
      summary: "Preview untracked cleanup candidates before any destructive command.",
      confirmation_kind: "none",
      explain: "Dry-run preview does not mutate state.",
    },
    {
      id: "discard_unstaged_changes",
      danger_level: 3,
      danger: "severe",
      applies: hasUnstaged && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "unstaged_paths not empty",
        "explicit operator confirmation",
        "no active .ato/.git lock contention",
      ],
      command: "git restore --worktree -- <unstaged-paths>",
      summary: "Destructive discard of unstaged tracked changes.",
      confirmation_kind: "confirm_token",
      explain: "Discarding worktree edits requires a strong confirmation token.",
    },
    {
      id: "clean_untracked_force",
      danger_level: 3,
      danger: "severe",
      applies: hasUntracked && !lockContention,
      default_recommendation: "refuse",
      preconditions: [
        "untracked_paths not empty",
        "explicit operator confirmation",
        "no active .ato/.git lock contention",
      ],
      command: "git clean -fd",
      summary: "Destructive removal of untracked files after explicit confirmation.",
      confirmation_kind: "confirm_token",
      explain: "Destructive cleanup requires a strong confirmation token.",
    },
  ];
};

export const buildGitCleanPlan = ({
  status,
  locks,
  maxLevel,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
  maxLevel: DangerLevel;
}): GitPlanCleanSnapshot => ({
  schema_version: "git-plan-clean.v1",
  ...buildBaseSnapshot({
    status,
    locks,
    maxLevel,
    level3Available: status.untracked_paths.length > 0,
  }),
  actions: filterByMaxLevel(buildCleanActions({ status, locks }), maxLevel),
});

export const buildGitCommitPlan = ({
  status,
  locks,
  maxLevel,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
  maxLevel: DangerLevel;
}): GitPlanCommitSnapshot => ({
  schema_version: "git-plan-commit.v1",
  ...buildBaseSnapshot({
    status,
    locks,
    maxLevel,
    level3Available:
      status.unstaged_paths.length > 0 || status.untracked_paths.length > 0,
  }),
  actions: filterByMaxLevel(buildCommitActions({ status, locks }), maxLevel),
});

export const buildGitStashPlan = ({
  status,
  locks,
  maxLevel,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
  maxLevel: DangerLevel;
}): GitPlanStashSnapshot => ({
  schema_version: "git-plan-stash.v1",
  ...buildBaseSnapshot({
    status,
    locks,
    maxLevel,
    level3Available: status.untracked_paths.length > 0,
  }),
  actions: filterByMaxLevel(buildStashActions({ status, locks }), maxLevel),
});

export const buildGitRestorePlan = ({
  status,
  locks,
  maxLevel,
}: {
  status: GitStatusSnapshot;
  locks: GitLocksSnapshot;
  maxLevel: DangerLevel;
}): GitPlanRestoreSnapshot => ({
  schema_version: "git-plan-restore.v1",
  ...buildBaseSnapshot({
    status,
    locks,
    maxLevel,
    level3Available:
      status.unstaged_paths.length > 0 || status.untracked_paths.length > 0,
  }),
  actions: filterByMaxLevel(buildRestoreActions({ status, locks }), maxLevel),
});
