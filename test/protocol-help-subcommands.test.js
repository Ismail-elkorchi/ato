import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cliPath = path.resolve("dist/cli/main.js");

test("protocol check --help prints usage without executing protocol check", () => {
  const result = spawnSync(process.execPath, [cliPath, "protocol", "check", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: ato protocol check \[options\]/);
  assert.equal(result.stdout.includes("protocol: ok"), false, result.stdout);
});

test("protocol --help prints usage", () => {
  const result = spawnSync(process.execPath, [cliPath, "protocol", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: ato protocol check \[options\]/);
});
