import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_TRANSITION_REGISTRY,
  STATUS_TRANSITION_REGISTRY_VERSION,
  computeStatusTransition,
} from "../dist/core/state/transitions.js";

const makeInput = (overrides = {}) => ({
  active_cycle_id: null,
  abort_reason: null,
  dirty_tree: false,
  selection_failure: false,
  missing_active_block: false,
  next_block_id: "block-0002",
  selection_failure_block_label: "block-0001",
  ...overrides,
});

test("status transition registry order is stable", () => {
  assert.deepEqual(
    STATUS_TRANSITION_REGISTRY.map((entry) => entry.state),
    [
      "abort_required",
      "dirty_tree",
      "active_cycle",
      "missing_active_block",
      "block_exhaustion",
      "selection_failure",
      "ready_to_start",
    ],
  );
});

test("abort transition wins over all other states", () => {
  const decision = computeStatusTransition(
    makeInput({
      abort_reason: "block config missing (block-0001)",
      dirty_tree: true,
      active_cycle_id: "CY-9999",
      selection_failure: true,
      missing_active_block: true,
    }),
  );
  assert.equal(
    decision.next_action,
    'ato cycle abort --reason "block config missing (block-0001)" --json',
  );
  assert.equal(decision.next_action_state, "abort_required");
  assert.equal(decision.next_action_reason, "abort_reason_present");
  assert.equal(decision.next_action_source, STATUS_TRANSITION_REGISTRY_VERSION);
});

test("dirty tree transition routes to finish when a cycle is active", () => {
  const decision = computeStatusTransition(
    makeInput({
      dirty_tree: true,
      active_cycle_id: "CY-0005",
    }),
  );
  assert.equal(
    decision.next_action,
    "clean working tree (commit/stash/restore) then run ato cycle finish --json",
  );
  assert.equal(decision.next_action_state, "dirty_tree");
  assert.equal(decision.next_action_reason, "dirty_tree_requires_cleanup");
});

test("selection failure blocks dirty-tree override", () => {
  const decision = computeStatusTransition(
    makeInput({
      dirty_tree: true,
      selection_failure: true,
      selection_failure_block_label: "block-0008",
    }),
  );
  assert.equal(
    decision.next_action,
    "Create a queued/active block-scoped evidence-backed item (title must include block-0008; include spec.outcome, spec.plan.steps, and spec.inputs/evidence).",
  );
  assert.equal(decision.next_action_state, "selection_failure");
  assert.equal(decision.next_action_reason, "no_eligible_block_scoped_items");
});

test("block exhaustion transition supersedes generic selection failure", () => {
  const decision = computeStatusTransition(
    makeInput({
      selection_failure: true,
      block_exhausted: true,
      selection_failure_block_label: "block-0011",
      next_block_id: "block-0012",
      block_exhaustion_action:
        "ato block close --block-id block-0011 --json && ato block open --block-id block-0012 --baseline baseline-main --json",
    }),
  );
  assert.equal(
    decision.next_action,
    "ato block close --block-id block-0011 --json && ato block open --block-id block-0012 --baseline baseline-main --json",
  );
  assert.equal(decision.next_action_state, "block_exhaustion");
  assert.equal(decision.next_action_reason, "block_cycles_planned_reached");
});

test("ready-to-start transition is deterministic for equivalent inputs", () => {
  const first = computeStatusTransition(
    makeInput({
      selection_failure_block_label: "block-0011",
      next_block_id: "block-0012",
    }),
  );
  const second = computeStatusTransition(
    makeInput({
      next_block_id: "block-0012",
      selection_failure_block_label: "block-0011",
    }),
  );
  assert.deepEqual(first, second);
  assert.equal(first.next_action, "ato cycle start --json");
  assert.equal(first.next_action_state, "ready_to_start");
  assert.equal(first.next_action_reason, "ready_for_cycle_start");
});
