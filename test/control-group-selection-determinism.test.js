import { test } from "node:test";
import assert from "node:assert/strict";

import { selectControlGroupCandidate } from "../dist/core/eval/select.js";

test("control-group selection is deterministic and sorts the pool", () => {
  const seed = "block-0006";
  const pool = ["BL-0100", "BL-0002", "BL-0099"];

  const first = selectControlGroupCandidate({ seed, poolIds: pool });
  const second = selectControlGroupCandidate({ seed, poolIds: pool });

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first, second);
  assert.deepEqual(first.pool_ids, ["BL-0002", "BL-0099", "BL-0100"]);
  assert.equal(first.chosen_id, second.chosen_id);
  assert.match(first.rule, /sha256/);
});
