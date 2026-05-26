import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

const assertHelpOutput = (result, expected) => {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(expected));
};

test("q --help prints queue help and exits 0", () => {
  const result = runCli(["q", "--help"]);
  assertHelpOutput(result, "Usage: ato q <subcommand> [options]");
});

test("q with no subcommand prints queue help and exits 0", () => {
  const result = runCli(["q"]);
  assertHelpOutput(result, "Usage: ato q <subcommand> [options]");
});

test("contract-refs fix help is specific and distinct", () => {
  const router = runCli(["q", "contract-refs", "--help"]);
  const fix = runCli(["q", "contract-refs", "fix", "--help"]);
  assertHelpOutput(router, "Usage: ato q contract-refs <action> [options]");
  assertHelpOutput(fix, "Usage: ato q contract-refs fix --ids <id,...>");
  assert.ok(fix.stdout.includes("--ids"));
  assert.ok(fix.stdout.includes("--dest"));
  assert.ok(fix.stdout.includes("--apply"));
  assert.notEqual(router.stdout, fix.stdout);
});
