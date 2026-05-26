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

test("git status command is deterministic and read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-status-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);
    await fs.writeFile(path.join(root, "a.txt"), "base\n", "utf8");
    await fs.writeFile(path.join(root, "z.txt"), "base\n", "utf8");
    commitAll(root);

    await fs.writeFile(path.join(root, "z.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(root, "a.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(root, "u.txt"), "new\n", "utf8");
    const stage = spawnSync("git", ["add", "a.txt"], { cwd: root, encoding: "utf8" });
    assert.equal(stage.status, 0, stage.stderr);

    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(before.status, 0, before.stderr);

    const cliPath = path.resolve("dist/cli/main.js");
    const first = spawnSync(
      process.execPath,
      [cliPath, "git", "status", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync(
      process.execPath,
      [cliPath, "git", "status", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);

    assert.equal(first.stdout, second.stdout);

    const payload = JSON.parse(first.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.schema_version, "git-status.v2");
    assert.equal(payload.dirty, true);
    assert.deepEqual(payload.dirty_paths, ["a.txt", "u.txt", "z.txt"]);
    assert.deepEqual(payload.tracked_paths, ["a.txt", "z.txt"]);
    assert.deepEqual(payload.untracked_paths, ["u.txt"]);
    assert.deepEqual(payload.staged_paths, ["a.txt"]);
    assert.deepEqual(payload.unstaged_paths, ["z.txt"]);
    assert.deepEqual(payload.optional_locks, {
      strategy: "env",
      env_var: "GIT_OPTIONAL_LOCKS",
      value: "0",
    });
    assert.equal(payload.status_error, null);
    assert.equal(payload.porcelain_error, null);
    assert.ok(!first.stdout.includes(root));

    const after = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(before.stdout, after.stdout);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
