import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const run = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
};

test("q transition commands are removed", () => {
  const commands = [
    ["q", "next", "--json"],
    ["q", "start", "BL-0001", "--json"],
    ["q", "done", "BL-0001", "--json"],
    ["q", "block", "BL-0001", "--json"],
    ["q", "defer", "BL-0001", "--json"],
  ];

  for (const args of commands) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.message, "Unknown queue subcommand.");
  }
});
