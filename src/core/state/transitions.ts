export const STATUS_TRANSITION_REGISTRY_VERSION = "status-transition-registry.v1";

export type StatusTransitionState =
  | "abort_required"
  | "dirty_tree"
  | "active_cycle"
  | "missing_active_block"
  | "block_exhaustion"
  | "selection_failure"
  | "ready_to_start";

export type StatusTransitionReason =
  | "abort_reason_present"
  | "dirty_tree_requires_cleanup"
  | "active_cycle_in_progress"
  | "no_active_block_open_next_block"
  | "block_cycles_planned_reached"
  | "no_eligible_block_scoped_items"
  | "ready_for_cycle_start";

export type StatusTransitionInput = {
  active_cycle_id: string | null;
  abort_reason: string | null;
  dirty_tree: boolean;
  selection_failure: boolean;
  missing_active_block: boolean;
  next_block_id: string;
  selection_failure_block_label: string;
  block_exhausted?: boolean;
  block_exhaustion_action?: string;
};

export type StatusTransitionDecision = {
  next_action: string;
  next_action_state: StatusTransitionState;
  next_action_reason: StatusTransitionReason;
  next_action_source: typeof STATUS_TRANSITION_REGISTRY_VERSION;
};

type StatusTransitionRule = {
  state: StatusTransitionState;
  reason: StatusTransitionReason;
  when: (input: StatusTransitionInput) => boolean;
  action: (input: StatusTransitionInput) => string;
};

const abortAction = (reason: string): string =>
  `ato cycle abort --reason "${reason}" --json`;

export const buildSelectionFailureGuidance = (blockLabel: string): string =>
  "Create a queued/active block-scoped evidence-backed item " +
  `(title must include ${blockLabel}; include spec.outcome, spec.plan.steps, and spec.inputs/evidence).`;

export const STATUS_TRANSITION_REGISTRY: readonly StatusTransitionRule[] = [
  {
    state: "abort_required",
    reason: "abort_reason_present",
    when: (input) => Boolean(input.abort_reason),
    action: (input) => abortAction(input.abort_reason ?? "unknown abort reason"),
  },
  {
    state: "dirty_tree",
    reason: "dirty_tree_requires_cleanup",
    when: (input) => input.dirty_tree && !input.selection_failure,
    action: (input) =>
      "clean working tree (commit/stash/restore) then run " +
      (input.active_cycle_id ? "ato cycle finish --json" : "ato cycle start --json"),
  },
  {
    state: "active_cycle",
    reason: "active_cycle_in_progress",
    when: (input) => Boolean(input.active_cycle_id),
    action: () => "ato cycle finish --json",
  },
  {
    state: "missing_active_block",
    reason: "no_active_block_open_next_block",
    when: (input) => input.missing_active_block,
    action: (input) => `Open next block ${input.next_block_id}.`,
  },
  {
    state: "block_exhaustion",
    reason: "block_cycles_planned_reached",
    when: (input) => input.selection_failure && input.block_exhausted === true,
    action: (input) =>
      input.block_exhaustion_action ??
      `Close exhausted block ${input.selection_failure_block_label} and open next block ${input.next_block_id}.`,
  },
  {
    state: "selection_failure",
    reason: "no_eligible_block_scoped_items",
    when: (input) => input.selection_failure,
    action: (input) =>
      buildSelectionFailureGuidance(input.selection_failure_block_label),
  },
  {
    state: "ready_to_start",
    reason: "ready_for_cycle_start",
    when: () => true,
    action: () => "ato cycle start --json",
  },
];

export const computeStatusTransition = (
  input: StatusTransitionInput,
): StatusTransitionDecision => {
  for (const rule of STATUS_TRANSITION_REGISTRY) {
    if (!rule.when(input)) continue;
    return {
      next_action: rule.action(input),
      next_action_state: rule.state,
      next_action_reason: rule.reason,
      next_action_source: STATUS_TRANSITION_REGISTRY_VERSION,
    };
  }
  throw new Error("Status transition registry has no matching rule.");
};
