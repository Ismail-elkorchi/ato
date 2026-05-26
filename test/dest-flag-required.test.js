import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

test("q contract-refs fix requires --dest", () => {
  const result = runCli([
    "q",
    "contract-refs",
    "fix",
    "--ids",
    "BL-0001",
    "--json",
  ]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes("Missing destination --dest"));
});
