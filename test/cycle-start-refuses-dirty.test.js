import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeAgents = async (root) => {
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
};

const writeConfig = async (root) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
  });
};

const initGit = (root) => {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
};

test("cycle start refuses dirty tree with DIRTY_TREE payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-dirty-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "DIRTY_TREE");
  assert.equal(
    payload.error?.message,
    "Clean working tree (commit/stash/restore) before cycle start.",
  );
  assert.ok(Array.isArray(payload.dirty_paths));
  assert.ok(payload.dirty_paths.includes("AGENTS.md"));
  assert.ok(Array.isArray(payload.suggested_fix));
  assert.ok(payload.suggested_fix.length > 0);
});
