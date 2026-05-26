import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runCli = (cwd, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
};

const resolveTempBase = (repoRoot) => {
  const tmpRoot = os.tmpdir();
  const rel = path.relative(repoRoot, tmpRoot);
  const isInside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isInside) return tmpRoot;
  return path.join(path.dirname(repoRoot), ".ato-test-tmp");
};

test("commands refuse outside any .ato tree", async () => {
  const repoRoot = path.resolve(".");
  const tempBase = resolveTempBase(repoRoot);
  await fs.mkdir(tempBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempBase, "ato-no-repo-"));
  const result = runCli(root, ["status", "--json"]);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "ATO_NOT_INITIALIZED");
  assert.deepEqual(payload.suggested_fix, ["ato init --json"]);
});
