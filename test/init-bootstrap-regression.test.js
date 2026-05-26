import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

test("init seeds bootstrap artifacts for cycle start", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-init-"));
  const cliPath = path.resolve("dist/cli/main.js");
  initGit(root);

  const init = spawnSync(
    process.execPath,
    [cliPath, "init", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(init.status, 0, init.stderr);
  const initPayload = JSON.parse(init.stdout.trim());
  assert.equal(initPayload.ok, true);

  assert.equal(await fileExists(path.join(root, "AGENTS.md")), true);
  assert.equal(
    await fileExists(path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md")),
    true,
  );

  const index = spawnSync(
    process.execPath,
    [cliPath, "contract", "index", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(index.status, 0, index.stderr);

  const extract = spawnSync(
    process.execPath,
    [cliPath, "contract", "extract", "--queue", "BL-0001", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(extract.status, 0, extract.stderr);
  const extractPayload = JSON.parse(extract.stdout.trim());
  assert.equal(extractPayload.ok, true);
  assert.equal(extractPayload.sections.length, 1);

  commitAll(root);

  const status = spawnSync(
    process.execPath,
    [cliPath, "status", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout.trim());
  assert.equal(statusPayload.ok, true);

  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  assert.equal(startPayload.ok, true);
});
