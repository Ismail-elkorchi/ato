import { test } from "node:test";
import assert from "node:assert/strict";

import { queryCausalLinks } from "../dist/core/memory/causal.js";

test("queryCausalLinks uses OR by default", () => {
  const links = [
    {
      id: "c1",
      createdAt: "2025-01-01T00:00:00.000Z",
      action: { type: "command", value: "npm test" },
      outcome: "green",
      confidence: 0.9,
    },
    {
      id: "c2",
      createdAt: "2025-01-01T00:00:00.000Z",
      action: { type: "file", value: "src/app.ts" },
      outcome: "updated",
      confidence: 0.7,
    },
  ];
  const entries = queryCausalLinks({
    links,
    command: "npm",
    file: "src/app.ts",
    mode: "or",
  });
  assert.equal(entries.length, 2);
});

test("queryCausalLinks supports AND mode", () => {
  const links = [
    {
      id: "c1",
      createdAt: "2025-01-01T00:00:00.000Z",
      action: { type: "command", value: "npm test" },
      outcome: "green",
      confidence: 0.9,
    },
    {
      id: "c2",
      createdAt: "2025-01-01T00:00:00.000Z",
      action: { type: "file", value: "src/app.ts" },
      outcome: "updated",
      confidence: 0.7,
    },
  ];
  const entries = queryCausalLinks({
    links,
    command: "npm",
    file: "src/app.ts",
    mode: "and",
  });
  assert.equal(entries.length, 0);
});
