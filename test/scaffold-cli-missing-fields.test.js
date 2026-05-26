import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runCli = (spec) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const args = [
    "--json",
    "scaffold",
    "--input",
    JSON.stringify(spec),
    "--dry-run",
  ];
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
};

const cases = [
  {
    label: "summary",
    spec: { name: "Cli Missing Fields", description: "desc", usage: "use" },
  },
  {
    label: "description",
    spec: { name: "Cli Missing Fields", summary: "sum", usage: "use" },
  },
  {
    label: "usage",
    spec: { name: "Cli Missing Fields", summary: "sum", description: "desc" },
  },
];

test("scaffold CLI rejects missing summary/description/usage with code 3", () => {
  for (const entry of cases) {
    const result = runCli(entry.spec);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 3);
    assert.ok(
      payload.error.message.toLowerCase().includes(entry.label),
      `expected error to mention ${entry.label}`,
    );
  }
});
