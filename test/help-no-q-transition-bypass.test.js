import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("help output omits q transition commands", () => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout;
  const forbidden = [
    /\bq next\b/i,
    /\bq start\b/i,
    /\bq done\b/i,
    /\bq block\b/i,
    /\bq defer\b/i,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(stdout), `found forbidden command: ${pattern}`);
  }
});
