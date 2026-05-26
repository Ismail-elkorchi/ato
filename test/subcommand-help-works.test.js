import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

const cases = [
  {
    args: ["q", "contract-refs", "fix", "--help"],
    expect: "Usage: ato q contract-refs fix",
  },
  {
    args: ["session", "closeout", "apply", "--help"],
    expect: "Usage: ato session closeout apply",
  },
  {
    args: ["q", "transfer", "--help"],
    expect: "Usage: ato q transfer",
  },
];

test("nested --help prints subcommand help", () => {
  for (const entry of cases) {
    const result = runCli(entry.args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(entry.expect));
  }
});
