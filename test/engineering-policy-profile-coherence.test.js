import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const readText = async (relativePath) =>
  fs.readFile(path.join(process.cwd(), relativePath), "utf8");

test("EP-12.1 checks require canonical profile location and BREAKING obligations", async () => {
  const checks = await readText(".ato/library/ENGINEERING_POLICY_CHECKS.md");

  assert.match(
    checks,
    /## EP-12\.1 Stability profile \+ EXPERIMENTAL breaking obligations/,
  );
  assert.match(checks, /exactly one canonical location/i);
  assert.match(checks, /\.ato\/config\.json/);
  assert.match(checks, /does not declare `ato\.stabilityProfile`/i);
  assert.match(checks, /BREAKING:/);
  assert.match(checks, /user-facing contract\/doc citation/i);
});

test("baseline removes platform-contract contradiction and records EP-12.1 evidence", async () => {
  const baseline = await readText(".ato/library/ENGINEERING_POLICY_BASELINE.md");

  assert.match(
    baseline,
    /## EP-2\.1 Contracts exist for declared boundaries — PASS/,
  );
  assert.match(baseline, /\.ato\/contracts\/PLATFORM_CONTRACT\.md/);
  assert.doesNotMatch(
    baseline,
    /PLATFORM_CONTRACT\.md.*(missing|does not exist)/i,
  );
  assert.match(
    baseline,
    /## EP-12\.1 Stability profile \+ EXPERIMENTAL breaking obligations — PASS/,
  );
  assert.match(baseline, /stabilityProfile: "EXPERIMENTAL"/);
  assert.match(
    baseline,
    /`package\.json` does not declare `ato\.stabilityProfile`/,
  );
});

test("user guide declares .ato/config.json as canonical stability profile source", async () => {
  const guide = await readText("docs/USER_GUIDE.md");

  assert.match(guide, /\.ato\/config\.json.*canonical for this repo/i);
  assert.match(guide, /package\.json.*must not declare `ato\.stabilityProfile`/i);
  assert.match(guide, /BREAKING: policy-check enforcement now rejects/i);
});
