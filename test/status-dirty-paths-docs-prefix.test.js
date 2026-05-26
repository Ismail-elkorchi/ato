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

const commitAll = (root) => {
  const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
};

test("status keeps docs/ prefix and strips leading dot from .ato paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-dirty-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);

  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, ".ato", "queue"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "USER_GUIDE.md"), "seed\n", "utf8");
  await fs.writeFile(
    path.join(root, ".ato", "queue", "items.jsonl"),
    "{\"id\":\"BL-0001\"}\n",
    "utf8",
  );
  commitAll(root);

  await fs.appendFile(path.join(root, "docs", "USER_GUIDE.md"), "dirty\n", "utf8");
  await fs.appendFile(
    path.join(root, ".ato", "queue", "items.jsonl"),
    "{\"id\":\"BL-0002\"}\n",
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "status.v2");
  assert.equal("intent_summary" in payload, false);
  assert.equal(payload.dirty_tree, true);
  assert.ok(payload.dirty_paths.includes("docs/USER_GUIDE.md"));
  assert.ok(payload.dirty_paths.includes("ato/queue/items.jsonl"));
  assert.ok(!payload.dirty_paths.some((entry) => entry.startsWith("ocs/")));
});
