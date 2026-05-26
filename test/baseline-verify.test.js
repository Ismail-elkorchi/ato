import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
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

const tagBaseline = (root, tag) => {
  const result = spawnSync("git", ["tag", tag], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

const writeBaselineRegistry = async ({
  root,
  tag,
  artifactPath,
  artifactSha,
}) => {
  const lockfilePath = path.join(root, "package-lock.json");
  await fs.writeFile(lockfilePath, "{\"lockfileVersion\":1}\n", "utf8");
  const lockSha = crypto
    .createHash("sha256")
    .update("{\"lockfileVersion\":1}\n")
    .digest("hex");

  await writeJson(path.join(root, ".ato", "meta", "baselines", `${tag}.json`), {
    schema_version: "baseline-registry.v1",
    tag,
    gate_profile: { id: "config-default", version: 1 },
    gate_command: "node dist/cli/main.js gate run --mode full --json",
    artifacts: [
      {
        path: artifactPath,
        sha256: artifactSha,
      },
    ],
    env: {
      node: "v20.0.0",
      npm: "0.0.0",
      platform: "test",
      lockfile: { path: "package-lock.json", sha256: lockSha },
    },
  });
};

const runBaselineVerify = (root, tag) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "baseline", "verify", "--tag", tag, "--json"],
    { cwd: root, encoding: "utf8" },
  );
  return result;
};

test("baseline verify fails when tag is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-baseline-missing-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBaselineRegistry({
    root,
    tag: "baseline-test",
    artifactPath: ".ato/runs/artifacts/global/gate/lint-1.log",
    artifactSha: crypto.createHash("sha256").update("ok").digest("hex"),
  });
  commitAll(root);

  const result = runBaselineVerify(root, "baseline-test");
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.some((error) => error.kind === "tag_not_found"));
});

test("baseline verify fails on missing artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-baseline-artifact-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBaselineRegistry({
    root,
    tag: "baseline-test",
    artifactPath: ".ato/runs/artifacts/global/gate/missing.log",
    artifactSha: crypto.createHash("sha256").update("missing").digest("hex"),
  });
  commitAll(root);
  tagBaseline(root, "baseline-test");

  const result = runBaselineVerify(root, "baseline-test");
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.some((error) => error.kind === "artifact_missing"));
});

test("baseline verify fails on sha mismatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-baseline-sha-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);

  const artifactPath = path.join(root, ".ato", "runs", "artifacts", "global", "gate");
  await fs.mkdir(artifactPath, { recursive: true });
  const artifactFile = path.join(artifactPath, "lint-1.log");
  await fs.writeFile(artifactFile, "actual", "utf8");

  await writeBaselineRegistry({
    root,
    tag: "baseline-test",
    artifactPath: ".ato/runs/artifacts/global/gate/lint-1.log",
    artifactSha: crypto.createHash("sha256").update("expected").digest("hex"),
  });
  commitAll(root);
  tagBaseline(root, "baseline-test");

  const result = runBaselineVerify(root, "baseline-test");
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.some((error) => error.kind === "sha256_mismatch"));
});

test("baseline verify fails on absolute paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-baseline-abs-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBaselineRegistry({
    root,
    tag: "baseline-test",
    artifactPath: "/tmp/baseline.log",
    artifactSha: crypto.createHash("sha256").update("abs").digest("hex"),
  });
  commitAll(root);
  tagBaseline(root, "baseline-test");

  const result = runBaselineVerify(root, "baseline-test");
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.some((error) => error.kind === "absolute_path"));
});
