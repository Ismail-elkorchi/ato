import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cliPath = path.resolve("dist/cli/main.js");

const TOP_LEVEL_COMMANDS = [
  "init",
  "repo",
  "q",
  "gate",
  "reflect",
  "plugin",
  "lesson",
  "pattern",
  "pack",
  "self",
  "diagnose",
  "capability",
  "baseline",
  "block",
  "contract",
  "dev",
  "trace",
  "deps",
  "lock",
  "git",
  "docs",
  "session",
  "telemetry",
  "signal",
  "memory",
  "impact",
  "refactor",
  "fixture",
  "scaffold",
  "test",
  "dashboard",
  "route",
  "bb",
  "protocol",
  "lint",
  "status",
  "cycle",
  "eval",
];

test("top-level <command> --help exits 0 and prints usage", () => {
  for (const command of TOP_LEVEL_COMMANDS) {
    const result = spawnSync(process.execPath, [cliPath, command, "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${command} --help exited non-zero: ${result.stderr}`);
    assert.match(
      result.stdout,
      /Usage:/,
      `${command} --help did not print usage text`,
    );
  }
});
