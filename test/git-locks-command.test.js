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

test("git locks command is deterministic when no locks exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-locks-clean-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);

    const cliPath = path.resolve("dist/cli/main.js");
    const first = spawnSync(
      process.execPath,
      [cliPath, "git", "locks", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync(
      process.execPath,
      [cliPath, "git", "locks", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);

    assert.equal(first.stdout, second.stdout);
    const payload = JSON.parse(first.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.schema_version, "git-locks.v1");
    assert.equal(payload.ato_lock.path, ".ato/lock.json");
    assert.equal(payload.ato_lock.exists, false);
    assert.equal(payload.git_lock.path, ".git/index.lock");
    assert.equal(payload.git_lock.exists, false);
    assert.ok(!first.stdout.includes(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("git locks command reports .ato and .git lock domains", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-locks-live-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);

    await writeJson(path.join(root, ".ato", "lock.json"), {
      pid: 999999,
      created_at: "2000-01-01T00:00:00.000Z",
    });
    await fs.writeFile(path.join(root, ".git", "index.lock"), "locked\n", "utf8");

    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(before.status, 0, before.stderr);

    const cliPath = path.resolve("dist/cli/main.js");
    const result = spawnSync(
      process.execPath,
      [cliPath, "git", "locks", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.schema_version, "git-locks.v1");
    assert.equal(payload.ato_lock.path, ".ato/lock.json");
    assert.equal(payload.ato_lock.exists, true);
    assert.equal(payload.ato_lock.stale, true);
    assert.equal(payload.git_lock.path, ".git/index.lock");
    assert.equal(payload.git_lock.exists, true);
    assert.equal(typeof payload.git_lock.mtime, "string");
    assert.equal(typeof payload.git_lock.ageMs, "number");
    assert.ok(!result.stdout.includes(root));

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
