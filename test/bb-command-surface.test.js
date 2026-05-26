import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("bb command surface matches show/post/export/import", () => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "bb"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /bb show\|post\|export\|import/);
  assert.ok(!/snapshot/i.test(output));
  assert.ok(!/note add/i.test(output));
});
