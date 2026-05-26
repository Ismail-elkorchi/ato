import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const writeFixtureTest = async (root) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const filePath = path.join(testDir, "fixture.test.js");
  const content = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("fixture ok", () => assert.ok(true));',
    "",
  ].join("\n");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
};

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const computeInvocationId = ({ runnerSha, concurrency, source, args }) => {
  const payload = JSON.stringify({
    runner_sha256: runnerSha,
    source,
    concurrency,
    args,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
};

const setupFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-test-runner-"));
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "runner-fixture",
        type: "module",
        version: pkg.version,
        scripts: {
          test: "node scripts/parallel-runner.mjs test/*.test.js",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const fixturePath = await writeFixtureTest(root);
  return { root, fixturePath, runnerPath, pkgVersion: pkg.version };
};

const resolveProofPath = (root, proofPath) => {
  const segments = proofPath.split("/");
  return path.join(root, ...segments);
};

const loadProofHelpers = async (runnerPath) => {
  const moduleUrl = pathToFileURL(runnerPath).href;
  const module = await import(moduleUrl);
  return {
    computeArgvFingerprint: module.computeArgvFingerprint,
    computeProofSecretHash: module.computeProofSecretHash,
  };
};

const runRunner = async (envOverrides = {}) => {
  const fixture = await setupFixture();
  const env = { ...process.env, ...envOverrides };
  delete env.ATO_TEST_SHARD;
  if (!("ATO_TEST_CONCURRENCY" in envOverrides)) {
    delete env.ATO_TEST_CONCURRENCY;
  }
  const result = spawnSync(
    process.execPath,
    [fixture.runnerPath, fixture.fixturePath],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [headerLine] = result.stdout.split(/\r?\n/);
  assert.ok(headerLine);
  const relFixture = path
    .relative(fixture.root, fixture.fixturePath)
    .replace(/\\/g, "/");
  return { header: JSON.parse(headerLine), relFixture, ...fixture };
};

test("test runner honors ATO_TEST_CONCURRENCY override", async () => {
  const { header, relFixture, runnerPath, root, pkgVersion } =
    await runRunner({
      ATO_TEST_CONCURRENCY: "2",
    });
  const { computeArgvFingerprint, computeProofSecretHash } =
    await loadProofHelpers(runnerPath);
  const runnerSha = await hashFile(runnerPath);
  const invocationId = computeInvocationId({
    runnerSha,
    concurrency: 2,
    source: "env",
    args: [relFixture],
  });
  try {
    assert.equal(header.runner_id, "ato-parallel-runner");
    assert.equal(header.runner_version, pkgVersion);
    assert.equal(header.runner_sha256, runnerSha);
    assert.equal(header.invocation_id, invocationId);
    const argvFingerprint = computeArgvFingerprint([relFixture]);
    const proofSecretHash = computeProofSecretHash({
      argvFingerprint,
      runnerSha256: runnerSha,
      invocationId,
    });
    assert.equal(header.proof_secret_hash, proofSecretHash);
    assert.equal(header.concurrency, 2);
    assert.equal(header.source, "env");
    assert.ok(Number.isInteger(header.detected_parallelism));
    assert.ok(header.detected_parallelism >= 1);
    assert.ok(header.proof_path);
    assert.equal(path.isAbsolute(header.proof_path), false);
    assert.ok(!header.proof_path.includes("\\"));

    const proofPath = resolveProofPath(root, header.proof_path);
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
    assert.equal(proof.proof_kind, "runner_exec.v1");
    assert.equal(proof.runner_id, "ato-parallel-runner");
    assert.equal(proof.runner_sha256, runnerSha);
    assert.equal(proof.invocation_id, invocationId);
    assert.equal(proof.proof_secret_hash, proofSecretHash);
    assert.equal(proof.env_source, "env");
    assert.equal(proof.concurrency_value, 2);
    assert.equal(proof.argv_fingerprint, argvFingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("test runner auto uses detected parallelism with parseable header", async () => {
  const { header, relFixture, runnerPath, root, pkgVersion } =
    await runRunner();
  const { computeArgvFingerprint, computeProofSecretHash } =
    await loadProofHelpers(runnerPath);
  const runnerSha = await hashFile(runnerPath);
  const invocationId = computeInvocationId({
    runnerSha,
    concurrency: header.detected_parallelism,
    source: "auto",
    args: [relFixture],
  });
  try {
    assert.equal(header.runner_id, "ato-parallel-runner");
    assert.equal(header.runner_version, pkgVersion);
    assert.equal(header.runner_sha256, runnerSha);
    assert.equal(header.invocation_id, invocationId);
    const argvFingerprint = computeArgvFingerprint([relFixture]);
    const proofSecretHash = computeProofSecretHash({
      argvFingerprint,
      runnerSha256: runnerSha,
      invocationId,
    });
    assert.equal(header.proof_secret_hash, proofSecretHash);
    assert.equal(header.source, "auto");
    assert.ok(Number.isInteger(header.detected_parallelism));
    assert.ok(header.detected_parallelism >= 1);
    assert.equal(header.concurrency, header.detected_parallelism);
    assert.ok(header.proof_path);

    const proofPath = resolveProofPath(root, header.proof_path);
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
    assert.equal(proof.proof_kind, "runner_exec.v1");
    assert.equal(proof.runner_sha256, runnerSha);
    assert.equal(proof.invocation_id, invocationId);
    assert.equal(proof.proof_secret_hash, proofSecretHash);
    assert.equal(proof.env_source, "auto");
    assert.equal(proof.concurrency_value, header.detected_parallelism);
    assert.equal(proof.argv_fingerprint, argvFingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gate test step uses npm test runner", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const script = pkg.scripts?.test ?? "";
  assert.match(script, /scripts\/parallel-runner\.mjs/);

  const config = JSON.parse(await fs.readFile(".ato/config.json", "utf8"));
  const cmd = config.gates?.full?.tests?.root?.[0]?.cmd ?? [];
  assert.deepEqual(cmd, ["npm", "run", "test"]);
});
