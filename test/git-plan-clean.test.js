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

test("git plan clean is deterministic, read-only, and untracked-aware", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-plan-clean-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);
    await fs.writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
    commitAll(root);

    await fs.writeFile(path.join(root, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(root, "new.txt"), "new\n", "utf8");

    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(before.status, 0, before.stderr);

    const cliPath = path.resolve("dist/cli/main.js");
    const first = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "clean", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "clean", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);

    const maxLevelThree = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "clean", "--max-level", "3", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(maxLevelThree.status, 0, maxLevelThree.stderr);

    const includeLevelThree = spawnSync(
      process.execPath,
      [cliPath, "git", "plan", "clean", "--include-level3", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(includeLevelThree.status, 0, includeLevelThree.stderr);
    assert.equal(maxLevelThree.stdout, includeLevelThree.stdout);

    const payload = JSON.parse(first.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.schema_version, "git-plan-clean.v1");
    assert.equal(payload.mode, "read_only");
    assert.equal(payload.dirty, true);
    assert.equal(payload.max_level, 2);
    assert.deepEqual(payload.included_levels, [1, 2]);
    assert.deepEqual(payload.tracked_paths, ["tracked.txt"]);
    assert.deepEqual(payload.untracked_paths, ["new.txt"]);
    assert.ok(Array.isArray(payload.actions));
    assert.ok(payload.actions.some((entry) => entry.id === "review_untracked"));
    assert.ok(!payload.actions.some((entry) => entry.id === "clean_untracked_force"));
    assert.ok(
      payload.actions.every(
        (entry) =>
          ["none", "force", "confirm_token"].includes(entry.confirmation_kind) &&
          typeof entry.explain === "string" &&
          entry.explain.length > 0,
      ),
    );
    assert.ok(!first.stdout.includes(root));

    const levelThreePayload = JSON.parse(maxLevelThree.stdout.trim());
    assert.equal(levelThreePayload.max_level, 3);
    assert.deepEqual(levelThreePayload.included_levels, [1, 2, 3]);
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
