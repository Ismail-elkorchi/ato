import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

test("misplaced global --repo is rejected with guidance", () => {
  const result = runCli(["q", "list", "--repo", ".", "--json"]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(
    payload.error.message.includes("Global --repo must appear before the command token"),
  );
});

test("misplaced global --repo is rejected for nested commands", () => {
  const result = runCli(["repo", "resolve", "--repo", ".", "--json"]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(
    payload.error.message.includes("Global --repo must appear before the command token"),
  );
});
