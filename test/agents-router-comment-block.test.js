import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const extractRouterMap = (content) => {
  const match = content.match(/<!--\s*AGENTS_ROUTER_V1\s*([\s\S]*?)-->/);
  assert.ok(match, "Missing AGENTS_ROUTER_V1 comment block.");
  const body = match[1] ?? "";
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = new Map();
  for (const line of lines) {
    const index = line.indexOf("=");
    assert.ok(index > 0, `Invalid router key line: ${line}`);
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    assert.ok(key.length > 0, `Missing key in line: ${line}`);
    assert.ok(value.length > 0, `Missing value for key: ${key}`);
    assert.equal(entries.has(key), false, `Duplicate router key: ${key}`);
    entries.set(key, value);
  }
  return { entries, lineCount: lines.length };
};

const resolveProjectPath = (...segments) =>
  path.resolve(path.join(...segments));

test("AGENTS router comment block is parseable with required stable keys", async () => {
  const content = await fs.readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const { entries: router, lineCount } = extractRouterMap(content);

  const requiredKeys = [
    "router.version",
    "router.max_lines",
    "router.owner",
    "authority.l1",
    "authority.l2",
    "authority.l3",
    "authority.l4",
    "look_first.1",
    "look_first.2",
    "look_first.3",
    "look_first.4",
    "look_first.5",
    "stopline.1",
    "stopline.2",
    "stopline.3",
    "status.selection_failure_tiebreak",
    "glossary",
  ];

  for (const key of requiredKeys) {
    assert.equal(router.has(key), true, `Missing router key: ${key}`);
  }
  assert.equal(router.get("router.version"), "1");
  assert.equal(router.get("router.max_lines"), "40");
  assert.equal(router.get("router.owner"), "coding-agents");
  assert.equal(router.get("look_first.1"), "AGENTS.md");
  assert.equal(
    router.get("status.selection_failure_tiebreak"),
    "follow_status_next_action",
  );
  assert.equal(router.get("glossary"), "docs/GATE_FRAMEWORK_GLOSSARY.md");
  const maxLines = Number.parseInt(router.get("router.max_lines") ?? "40", 10);
  assert.equal(Number.isFinite(maxLines), true, "router.max_lines must be numeric");
  assert.ok(
    lineCount <= maxLines,
    `AGENTS_ROUTER_V1 block must stay compact (<= ${maxLines} lines), got ${lineCount}.`,
  );

  const referencedPathKeys = [
    "look_first.1",
    "look_first.2",
    "look_first.3",
    "look_first.4",
    "look_first.5",
    "glossary",
  ];
  for (const key of referencedPathKeys) {
    const value = router.get(key);
    assert.ok(value, `Missing router path value for ${key}`);
    const absolute = resolveProjectPath(value);
    const exists = await fs
      .stat(absolute)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, true, `Router path does not exist (${key}): ${value}`);
  }
});
