import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf8"));

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

test("repo resolve and init-seed honor explicit external store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-repo-ext-root-"));
  const storeBase = await fs.mkdtemp(path.join(os.tmpdir(), "ato-repo-ext-store-"));
  const storePath = path.join(storeBase, "state", ".ato");
  const cliPath = path.resolve("dist/cli/main.js");
  initGit(root);

  const init = spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "--store", storePath, "init", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(init.status, 0, init.stderr);
  commitAll(root);

  const nested = path.join(root, "nested", "dir");
  await fs.mkdir(nested, { recursive: true });

  const resolve = spawnSync(
    process.execPath,
    [cliPath, "--store", storePath, "repo", "resolve", "--json"],
    { cwd: nested, encoding: "utf8" },
  );
  assert.equal(resolve.status, 0, resolve.stderr);
  const resolvePayload = JSON.parse(resolve.stdout.trim());
  assert.equal(resolvePayload.ok, true);
  assert.equal(resolvePayload.repo.id, path.basename(root));

  const configPath = path.join(storePath, "config.json");
  const before = await readJson(configPath);
  await writeJson(configPath, {
    ...before,
    fingerprintSeed: undefined,
    fingerprint: undefined,
  });

  const reseed = spawnSync(
    process.execPath,
    [cliPath, "--store", storePath, "repo", "init-seed", "--json"],
    { cwd: nested, encoding: "utf8" },
  );
  assert.equal(reseed.status, 0, reseed.stderr || reseed.stdout);

  const updated = await readJson(configPath);
  assert.ok(updated.fingerprintSeed);
  assert.ok(updated.fingerprint);
});
