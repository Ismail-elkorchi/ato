import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("q update help lists all supported evidence prefixes", () => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "update", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /--evidence-add <file:\.\.\.\|cmd:\.\.\.\|log:\.\.\.\|output:\.\.\.>/,
  );
});
