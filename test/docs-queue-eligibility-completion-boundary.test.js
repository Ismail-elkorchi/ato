import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("USER_GUIDE distinguishes eligibility evidence from completion evidence", () => {
  const guide = readFileSync(path.resolve("docs/USER_GUIDE.md"), "utf8");
  assert.ok(
    guide.includes(
      "Selection evidence exists in `spec.inputs` or `item.evidence` (at least one entry).",
    ),
  );
  assert.ok(
    guide.includes(
      "This eligibility check does not change completion rules: `ato cycle finish` still requires citation-backed `spec.inputs` and treats `item.evidence` as supplemental.",
    ),
  );
});
