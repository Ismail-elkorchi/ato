import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPack } from "../dist/core/pack/generator.js";
import { countTokens } from "../dist/core/tokens.js";

test("pack output stays within token budget", () => {
  const queueItem = {
    id: "BL-0001",
    title: "Fix login",
    type: "bug",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    target: { selector: "exact", value: "v1" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Users cannot log in",
      outcome: "Login succeeds consistently",
      plan: {
        steps: ["Identify auth failure", "Fix login flow", "Verify"],
      },
      acceptance_criteria: ["Login works"],
      inputs: ["auth service"],
      deliverables: ["fixed login"],
      scope: ["src/auth"],
      risks: [],
      contract_refs: ["6.2 Ticket minimum fields"],
      runbook: [],
    },
    details: { needs: [] },
  };

  const routers = {
    root: {
      path: "AGENTS.md",
      content: "Root router rules and context.",
    },
  };

  const pack = buildPack({
    task: "Test pack",
    focus: null,
    budget: 450,
    format: "md",
    queueItem,
    routers,
    contractSections: [],
    blackboardSignals: [{ ts: "2024-01-01T00:00:00.000Z", summary: "signal" }],
    lessons: [
      {
        id: "LS-0001",
        pattern: "Login failures",
        prevention: "Add auth tests",
        frequency: 1,
        last_seen: "2024-01-01T00:00:00.000Z",
      },
    ],
    patterns: [
      {
        id: "PT-0001",
        title: "Auth regression",
        kind: "guard",
        frequency: 1,
        last_seen: "2024-01-01T00:00:00.000Z",
      },
    ],
    runLogEntries: [],
  });

  assert.equal(pack.overBudget, false);
  assert.ok(countTokens(pack.output) <= 450);
});

test("pack reports token requirement when over budget", () => {
  const queueItem = {
    id: "BL-0002",
    title: "Large pack",
    type: "feature",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    target: { selector: "exact", value: "v1" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Pack should exceed budget",
      outcome: "Budget enforced",
      plan: {
        steps: ["Generate pack", "Verify budget signal"],
      },
      acceptance_criteria: ["Budget check"],
      inputs: ["input"],
      deliverables: ["deliverable"],
      scope: [],
      risks: [],
      contract_refs: ["6.2 Ticket minimum fields"],
      runbook: [],
    },
    details: {},
  };

  const routers = {
    root: {
      path: "AGENTS.md",
      content: "word ".repeat(200),
    },
  };

  const pack = buildPack({
    task: "Over budget",
    focus: null,
    budget: 10,
    format: "md",
    queueItem,
    routers,
    contractSections: [],
    blackboardSignals: [],
    lessons: [],
    patterns: [],
    runLogEntries: [],
  });

  assert.equal(pack.overBudget, true);
  assert.ok(pack.requiredTokens > 10);
  assert.equal(pack.requiredTokens, countTokens(pack.output));
});
