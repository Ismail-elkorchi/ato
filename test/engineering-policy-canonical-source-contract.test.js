import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

test("ENGINEERING_POLICY declares .ato/config.json as canonical stability source", async () => {
  const policyPath = path.resolve(".ato/contracts/ENGINEERING_POLICY.md");
  const policy = await fs.readFile(policyPath, "utf8");

  assert.match(
    policy,
    /For this repo, the Stability Profile MUST be declared in `\.ato\/config\.json` under `stabilityProfile`/,
  );
  assert.match(
    policy,
    /`package\.json` MUST NOT declare `ato\.stabilityProfile` for this repo\./,
  );
  assert.equal(
    /for example:\s*`\.ato\/config\.json`\s*or\s*`package\.json`/i.test(policy),
    false,
    "Legacy multi-source canonical wording must not reappear.",
  );
});
