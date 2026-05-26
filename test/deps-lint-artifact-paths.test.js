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

test("deps lint records artifact paths as repo-relative", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-deps-lint-paths-"));
  try {
    initGit(root);

    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
      "utf8",
    );
    await writeJson(path.join(root, ".ato", "config.json"), {
      version: 1,
      targetId: "tmp",
      storeDir: ".ato",
      fingerprintSeed: "seed",
    });
    await writeJson(path.join(root, "package.json"), {
      name: "tmp",
      version: "1.0.0",
      private: true,
    });
    commitAll(root);

    const cliPath = path.resolve("dist/cli/main.js");
    const result = spawnSync(process.execPath, [cliPath, "deps", "lint", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(path.isAbsolute(payload.artifact), false);
    assert.match(payload.artifact, /^\.ato\/runs\/artifacts\/global\/deps\//);
    assert.doesNotMatch(payload.artifact, /\/home\/|\/Users\/|[A-Za-z]:\\/);

    const artifactPath = path.join(root, payload.artifact);
    const artifactExists = await fs
      .stat(artifactPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(artifactExists, true);

    const runlogRaw = await fs.readFile(
      path.join(root, ".ato", "runs", "runs.jsonl"),
      "utf8",
    );
    const lines = runlogRaw.trim().split(/\r?\n/).filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(Array.isArray(last.artifacts), true);
    assert.equal(last.artifacts.length, 1);
    assert.equal(path.isAbsolute(last.artifacts[0]), false);
    assert.equal(last.artifacts[0], payload.artifact);
    assert.doesNotMatch(last.artifacts[0], /\/home\/|\/Users\/|[A-Za-z]:\\/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
