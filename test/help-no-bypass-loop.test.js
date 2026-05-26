import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("help output omits loop commands", () => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout;
  assert.ok(!stdout.includes("loop check|run"));
  assert.ok(!/^\s*loop\b/m.test(stdout));
  assert.match(stdout, /\bstatus\b/);
});
