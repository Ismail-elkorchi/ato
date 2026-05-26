import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const toPosix = (value) => value.replace(/\\/g, "/");

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf8"));

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

test("init supports explicit external store placement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-ext-store-root-"));
  const storeBase = await fs.mkdtemp(path.join(os.tmpdir(), "ato-ext-store-"));
  const storePath = path.join(storeBase, "state", ".ato");
  const cliPath = path.resolve("dist/cli/main.js");
  initGit(root);

  const init = spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "--store", storePath, "init", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(init.status, 0, init.stderr);
  const payload = JSON.parse(init.stdout.trim());
  assert.equal(payload.ok, true);

  const configPath = path.join(storePath, "config.json");
  const contractPath = path.join(storePath, "contracts", "PLATFORM_CONTRACT.md");
  assert.equal(await fileExists(configPath), true);
  assert.equal(await fileExists(contractPath), true);

  const config = await readJson(configPath);
  assert.equal(config.storeDir, toPosix(path.relative(root, storePath)));
  assert.equal(
    config.contracts.platform,
    toPosix(path.relative(root, contractPath)),
  );

  commitAll(root);

  const status = spawnSync(
    process.execPath,
    [cliPath, "--store", storePath, "status", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout.trim());
  assert.equal(statusPayload.ok, true);
});
