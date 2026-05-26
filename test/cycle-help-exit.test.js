import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cliPath = path.resolve("dist", "cli", "main.js");

test("cycle --help exits 0 and prints usage", () => {
  const result = spawnSync(process.execPath, [cliPath, "cycle", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /ato cycle start/);
  assert.ok(!/Unknown cycle subcommand/.test(result.stdout));
});
