import path from "node:path";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext, ensureProtocol } from "./shared.js";
import { readState } from "../../core/state.js";
import { computeStatusTransition } from "../../core/state/transitions.js";
import { fileExists, readJson } from "../../core/fs.js";
import { gatherGitStatus } from "../../core/git/status.js";
import { selectCycleQueueItem } from "../../core/cycle/select.js";
import { verifyBlockSeal } from "../../core/blocks/seal.js";
import {
  loadBlockConfig,
  resolveBaselineTag,
  resolveBlockState,
  resolveCyclesPlanned,
} from "../../core/blocks/config.js";
import { readCycleRecords } from "../../core/cycle/store.js";
import type { CommandContext } from "../types.js";

type GitPlanSuggestion = {
  category: "staged" | "unstaged_tracked" | "untracked";
  command: string;
  rationale: string;
  path_count: number;
  alternatives: string[];
};

type BlockExhaustionSummary = {
  block_id: string;
  cycles_planned: number;
  cycles_recorded: number;
  next_block_id: string;
  recommended_commands: string[];
};

const HELP = [
  "Usage:",
  "  ato status [--json]",
  "",
  "Options:",
  "  --json  Emit machine-readable JSON",
].join("\n");

const toRelativePath = (root: string, filePath: string): string | null => {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
};

const normalizePath = (root: string, value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return toRelativePath(root, trimmed);
  return trimmed.replace(/\\/g, "/");
};

const readStringField = (
  record: Record<string, unknown> | null,
  key: string,
): string | null => {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const readNestedStringField = (
  record: Record<string, unknown> | null,
  key: string,
  nestedKey: string,
): string | null => {
  if (!record) return null;
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[nestedKey];
  return typeof nested === "string" ? nested : null;
};

const buildGitPlanSuggestions = (
  gitStatus: Awaited<ReturnType<typeof gatherGitStatus>>,
): GitPlanSuggestion[] => {
  const suggestions: GitPlanSuggestion[] = [];
  if (gitStatus.staged_paths.length) {
    suggestions.push({
      category: "staged",
      command: "ato git plan commit --json",
      rationale: "Staged changes detected; evaluate commit workflow options.",
      path_count: gitStatus.staged_paths.length,
      alternatives: [],
    });
  }
  if (gitStatus.unstaged_paths.length) {
    suggestions.push({
      category: "unstaged_tracked",
      command: "ato git plan restore --json",
      rationale:
        "Unstaged tracked changes detected; evaluate restore-first or stage-and-commit path.",
      path_count: gitStatus.unstaged_paths.length,
      alternatives: ["ato git plan commit --json"],
    });
  }
  if (gitStatus.untracked_paths.length) {
    suggestions.push({
      category: "untracked",
      command: "ato git plan stash --json",
      rationale:
        "Untracked files detected; evaluate stash-first path before any clean operation.",
      path_count: gitStatus.untracked_paths.length,
      alternatives: ["ato git plan clean --json"],
    });
  }
  return suggestions;
};

export const runStatusCommand = async ({
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

  const target = await resolveTargetContext({ context, requireWrite: false });
  await ensureProtocol(target.root);

  const state = await readState(target.storePath);
  const activeCycleId = (state as { activeCycleId?: string }).activeCycleId ?? null;
  const activeQueueId =
    (state as { activeCycleQueueId?: string }).activeCycleQueueId ?? null;
  const gitStatus = gatherGitStatus(target.root);
  const gitPlanSuggestions = buildGitPlanSuggestions(gitStatus);
  const blockState = await resolveBlockState(target.storePath);
  const hasBlocks = blockState.block_ids.length > 0;
  const activeBlockId = blockState.active_block_id;
  const nextBlockId = blockState.next_block_id;
  const missingActiveBlock = hasBlocks && !activeBlockId;

  let activeCycle: Record<string, unknown> | null = null;
  let selectedQueueId: string | null = null;
  let abortReason: string | null = null;
  let contractExtractRef: string | null = null;
  let selectionFailure:
    | {
        candidates_total: number;
        candidates_eligible: number;
        excluded_by_reason: {
          out_of_scope: number;
          status: number;
          deps: number;
          missing_evidence: number;
        };
        block_id: string | null;
      }
    | null = null;

  if (activeCycleId) {
    const cycleDir = path.join(target.storePath, "cycles", activeCycleId);
    const cycleStatePath = path.join(cycleDir, "cycle-state.json");
    const cycleState = await readJson<Record<string, unknown> | null>(cycleStatePath, null);
    const queueId =
      (cycleState && typeof cycleState["queue_id"] === "string"
        ? cycleState["queue_id"]
        : null) ?? activeQueueId;
    const blockId =
      cycleState && typeof cycleState["block_id"] === "string"
        ? cycleState["block_id"]
        : null;
    const startedAt =
      cycleState && typeof cycleState["started_at"] === "string"
        ? cycleState["started_at"]
        : null;
    const paths: Record<string, string> = {};
    const cycleStateRel = toRelativePath(target.root, cycleStatePath);
    if (cycleStateRel) paths["cycle_state"] = cycleStateRel;
    const cycleStartRel = toRelativePath(
      target.root,
      path.join(cycleDir, "cycle-start.json"),
    );
    if (cycleStartRel) paths["cycle_start"] = cycleStartRel;
    const selectionRel = normalizePath(
      target.root,
      readStringField(cycleState, "selection_path"),
    );
    if (selectionRel) paths["selection"] = selectionRel;
    const preflightRel = normalizePath(
      target.root,
      readNestedStringField(cycleState, "preflight", "path"),
    );
    if (preflightRel) paths["preflight"] = preflightRel;
    const contractExtractState = normalizePath(
      target.root,
      readStringField(cycleState, "contract_extract_ref"),
    );
    if (contractExtractState) {
      contractExtractRef = contractExtractState;
      paths["contract_extract"] = contractExtractState;
    } else {
      const fallbackPath = path.join(cycleDir, "contract-extract.json");
      if (await fileExists(fallbackPath)) {
        const rel = toRelativePath(target.root, fallbackPath);
        if (rel) {
          contractExtractRef = rel;
          paths["contract_extract"] = rel;
        }
      }
    }

    activeCycle = {
      id: activeCycleId,
      queue_id: queueId,
      block_id: blockId,
      started_at: startedAt,
      ...(Object.keys(paths).length ? { paths } : {}),
    };
    selectedQueueId = queueId;

    if (blockId) {
      const blockPath = path.join(
        target.storePath,
        "meta",
        "blocks",
        `${blockId}.json`,
      );
      const blockConfig = await readJson<Record<string, unknown> | null>(blockPath, null);
      if (!blockConfig) {
        abortReason = `block config missing (${blockId})`;
      } else {
        const sealCheck = await verifyBlockSeal({
          root: target.root,
          store: target.storePath,
          targetId: target.id,
          config: target.config,
          blockId,
        });
        if (!sealCheck.ok) {
          abortReason = `block ${blockId} seal mismatch`;
        }
      }
    }
  } else {
    if (!missingActiveBlock) {
      try {
        const selection = await selectCycleQueueItem({
          store: target.storePath,
          targetId: target.id,
          blockId: activeBlockId,
        });
        selectedQueueId = selection.selection?.queue_id ?? null;
      } catch (error) {
        const err = error as Error & { code?: number; details?: unknown };
        if (err.code !== 3 || !err.details || typeof err.details !== "object") {
          throw error;
        }
        const details = err.details as Record<string, unknown>;
        const excludedRaw = details["excluded_by_reason"];
        const excluded =
          excludedRaw && typeof excludedRaw === "object" && !Array.isArray(excludedRaw)
            ? (excludedRaw as Record<string, unknown>)
            : null;
        if (!excluded) throw error;
        const toCount = (value: unknown): number => {
          const count = Number(value);
          return Number.isFinite(count) ? count : 0;
        };
        selectionFailure = {
          candidates_total: toCount(details["candidates_total"]),
          candidates_eligible: toCount(details["candidates_eligible"]),
          excluded_by_reason: {
            out_of_scope: toCount(excluded["out_of_scope"]),
            status: toCount(excluded["status"]),
            deps: toCount(excluded["deps"]),
            missing_evidence: toCount(excluded["missing_evidence"]),
          },
          block_id:
            typeof details["block_id"] === "string" ? details["block_id"] : null,
        };
      }
    }
  }

  let blockExhaustion: BlockExhaustionSummary | null = null;
  const blockExhausted =
    !activeCycleId &&
    Boolean(selectionFailure) &&
    activeBlockId === "block-0011";
  let blockExhaustionAction = "";
  if (blockExhausted && activeBlockId) {
    const blockConfig = await loadBlockConfig(target.storePath, activeBlockId);
    const cyclesPlanned = resolveCyclesPlanned(blockConfig);
    if (cyclesPlanned !== null) {
      const records = await readCycleRecords(target.storePath);
      const cyclesRecorded = records.filter(
        (record) => record.block_id === activeBlockId,
      ).length;
      if (cyclesRecorded >= cyclesPlanned) {
        const baselineTag = resolveBaselineTag(blockConfig) ?? "baseline_block0004_v0";
        const recommendedCommands = [
          `ato block close --block-id ${activeBlockId} --json`,
          `ato block open --block-id ${nextBlockId} --baseline ${baselineTag} --json`,
        ];
        blockExhaustion = {
          block_id: activeBlockId,
          cycles_planned: cyclesPlanned,
          cycles_recorded: cyclesRecorded,
          next_block_id: nextBlockId,
          recommended_commands: recommendedCommands,
        };
        blockExhaustionAction = `${recommendedCommands[0]} && ${recommendedCommands[1]}`;
      }
    }
  }

  const transition = computeStatusTransition({
    active_cycle_id: activeCycleId,
    abort_reason: abortReason,
    dirty_tree: gitStatus.dirty,
    selection_failure: Boolean(selectionFailure),
    missing_active_block: missingActiveBlock,
    next_block_id: nextBlockId,
    selection_failure_block_label:
      selectionFailure?.block_id ?? activeBlockId ?? nextBlockId,
    ...(blockExhaustion
      ? {
          block_exhausted: true,
          block_exhaustion_action: blockExhaustionAction,
        }
      : {}),
  });
  const nextAction = transition.next_action;

  let agentInstructions: string[] = [];
  if (abortReason) {
    agentInstructions = [`Run: ato cycle abort --reason "${abortReason}" --json`];
  } else if (activeCycleId) {
    agentInstructions = [
      ...(contractExtractRef
        ? [`Review contract extracts: ${contractExtractRef}`]
        : []),
      "Review selection/preflight artifacts.",
      "Review the queue item spec (problem/outcome/plan/deliverables/acceptance).",
      selectedQueueId
        ? `Implement queue item ${selectedQueueId}.`
        : "Implement the selected queue item.",
      "Run acceptance checks.",
      "Run: ato cycle finish --json",
    ];
  } else if (missingActiveBlock) {
    agentInstructions = [`Open next block ${nextBlockId}.`];
  } else if (blockExhaustion) {
    agentInstructions = [
      `Block ${blockExhaustion.block_id} is exhausted (${blockExhaustion.cycles_recorded}/${blockExhaustion.cycles_planned}).`,
      ...blockExhaustion.recommended_commands.map((command) => `Run: ${command}`),
    ];
  } else if (selectionFailure) {
    agentInstructions = [nextAction];
  } else {
    agentInstructions = ["Run: ato cycle start --json"];
  }
  if (gitStatus.dirty) {
    const planInstructionLines = gitPlanSuggestions.map(
      (entry) => `Git plan (${entry.category}): ${entry.command}`,
    );
    if (gitStatus.untracked_paths.length) {
      planInstructionLines.push(
        `Untracked files count as dirty too: ${gitStatus.untracked_paths.join(", ")}.`,
      );
    }
    agentInstructions = [
      "Inspect git preflight first: ato git status --json",
      "Inspect lock domains first: ato git locks --json",
      ...planInstructionLines,
      "Clean working tree (commit/stash/restore).",
      ...agentInstructions,
    ];
  }

  const payload = {
    ok: true,
    schema_version: "status.v2",
    active_cycle: activeCycle,
    selected_queue_id: selectedQueueId,
    active_block_id: activeBlockId,
    next_block_id: nextBlockId,
    next_action: nextAction,
    next_action_state: transition.next_action_state,
    next_action_reason: transition.next_action_reason,
    next_action_source: transition.next_action_source,
    dirty_tree: gitStatus.dirty,
    dirty_paths: gitStatus.dirty_paths,
    git_plan_suggestions: gitPlanSuggestions,
    agent_instructions: agentInstructions,
    ...(selectionFailure
      ? {
          candidates_total: selectionFailure.candidates_total,
          candidates_eligible: selectionFailure.candidates_eligible,
          excluded_by_reason: selectionFailure.excluded_by_reason,
        }
      : {}),
    ...(blockExhaustion ? { block_exhaustion: blockExhaustion } : {}),
    ...(contractExtractRef ? { contract_extract_ref: contractExtractRef } : {}),
  };

  if (json) {
    writeJson(payload);
  } else {
    const lines = [
      formatTargetLine(target),
      activeCycleId ? `active cycle: ${activeCycleId}` : "active cycle: none",
      selectedQueueId ? `queue: ${selectedQueueId}` : "queue: none",
      `next: ${nextAction}`,
    ];
    writeLines(lines);
  }
};
