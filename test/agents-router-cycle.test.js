import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const extractSection = (content, heading) => {
  const start = content.indexOf(heading);
  if (start === -1) return "";
  const rest = content.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
};

test("AGENTS.md default loop uses cycle start/finish", () => {
  const content = readFileSync(path.resolve("AGENTS.md"), "utf8");
  assert.match(content, /## Default Work Loop \(Cycle\)/);
  const section = extractSection(content, "## Default Work Loop (Cycle)");
  assert.match(section, /ato cycle start --json/);
  assert.match(section, /ato cycle finish --json/);
  assert.ok(!/ato q next/.test(section));
  assert.ok(!/ato q done/.test(section));
});
