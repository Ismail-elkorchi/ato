import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("USER_GUIDE documents git status schema_version v2", () => {
  const guidePath = path.resolve("docs/USER_GUIDE.md");
  const guide = readFileSync(guidePath, "utf8");
  assert.ok(
    guide.includes(
      "`git status` output is deterministic and path-sorted (`schema_version: git-status.v2`).",
    ),
  );
});
