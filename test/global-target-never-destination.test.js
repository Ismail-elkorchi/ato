import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

test("q transfer requires --dest even when global --repo is set", () => {
  const result = runCli(["--repo", ".", "q", "transfer", "BL-0001", "--json"]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes("Missing destination --dest"));
});
