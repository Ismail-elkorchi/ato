import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAdapter } from "../dist/core/adapters/registry.js";

test("resolveAdapter defaults to node", () => {
  const adapter = resolveAdapter();
  assert.equal(adapter.id, "node");
});

test("resolveAdapter rejects unknown adapter ids", () => {
  assert.throws(
    () => resolveAdapter("unknown"),
    (error) =>
      error instanceof Error &&
      error.message === "Unknown adapter id 'unknown'.",
  );
});
