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

test("git plan commit is deterministic, read-only, and staged/unstaged aware", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-plan-commit-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);
    await fs.writeFile(path.join(root, "staged.txt"), "base\n", "utf8");
    await fs.writeFile(path.join(root, "unstaged.txt"), "base\n", "utf8");
    commitAll(root);

    await fs.writeFile(path.join(root, "staged.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(root, "unstaged.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(root, "new.txt"), "new\n", "utf8");
    const stage = spawnSync("git", ["add", "staged.txt"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(stage.status, 0, stage.stderr);

    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(before.status, 0, before.stderr);

    const cliPath = path.resolve("dist/cli/main.js");
    const first = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "commit", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "commit", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);

    const levelThree = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "commit", "--max-level", "3", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(levelThree.status, 0, levelThree.stderr);

    const payload = JSON.parse(first.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.schema_version, "git-plan-commit.v1");
    assert.equal(payload.max_level, 2);
    assert.deepEqual(payload.included_levels, [1, 2]);
    assert.deepEqual(payload.staged_paths, ["staged.txt"]);
    assert.deepEqual(payload.unstaged_paths, ["unstaged.txt"]);
    assert.deepEqual(payload.untracked_paths, ["new.txt"]);
    assert.ok(payload.actions.some((entry) => entry.id === "stage_unstaged"));
    assert.ok(payload.actions.some((entry) => entry.id === "commit_staged"));
    assert.ok(!payload.actions.some((entry) => entry.id === "discard_unstaged_force"));
    assert.ok(!first.stdout.includes(root));

    const levelThreePayload = JSON.parse(levelThree.stdout.trim());
    assert.equal(levelThreePayload.max_level, 3);
    assert.ok(
      levelThreePayload.actions.some((entry) => entry.id === "discard_unstaged_force"),
    );
    assert.ok(
      levelThreePayload.actions.some((entry) => entry.id === "clean_untracked_force"),
    );

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
