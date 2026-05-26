import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const countMatches = (content, token) => {
  const matches = content.match(new RegExp(token, "g"));
  return matches ? matches.length : 0;
};

test("AGENTS router keys and invariant IDs stay stable", () => {
  const content = readFileSync(path.resolve("AGENTS.md"), "utf8");
  const requiredKeys = [
    "K-STATUS-CONTROL",
    "K-SAFETY-WRITE",
    "K-FINISH-CHECKLIST",
    "K-CYCLE-LOOP",
    "K-CONTRACT-ROUTING",
    "K-LOCKING",
    "K-REFERENCES",
  ];

  for (const key of requiredKeys) {
    assert.ok(countMatches(content, key) >= 1, `${key} must appear at least once`);
    assert.equal(
      countMatches(content, `\\(\\s*${key}\\s*\\)`),
      1,
      `${key} must appear in exactly one section heading`,
    );
  }

  const requiredInvariantIds = [
    "R-001",
    "R-002",
    "R-003",
    "R-004",
    "R-005",
    "R-006",
    "R-007",
    "R-008",
    "R-009",
    "R-010",
    "R-011",
    "R-012",
  ];

  for (const invariantId of requiredInvariantIds) {
    assert.equal(
      countMatches(content, invariantId),
      1,
      `${invariantId} must appear exactly once`,
    );
  }
});
