import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("engineering policy baseline references queue.v2 and current gate state", () => {
  const baseline = readFileSync(
    path.resolve(".ato/library/ENGINEERING_POLICY_BASELINE.md"),
    "utf8",
  );

  assert.ok(baseline.includes("## EP-1.1 Evidence discipline — PASS"));
  assert.ok(baseline.includes("src/core/schemas/queue.v2.json"));
  assert.ok(baseline.includes("src/core/queue/validate.ts"));
  assert.doesNotMatch(baseline, /queue\\.v1\\.json/);
  assert.doesNotMatch(baseline, /Gates are empty/i);
});
