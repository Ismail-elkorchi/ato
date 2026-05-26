import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sanitizeEnv = (env) => {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST")) {
      delete next[key];
    }
    if (key === "ATO_TEST_SHARD" || key === "ATO_TEST_CONCURRENCY") {
      delete next[key];
    }
  }
  return next;
};

const setupFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-runner-barrier-"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const relTest = "test/fixture.test.js";
  await fs.writeFile(
    path.join(root, relTest),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("fixture ok", () => assert.ok(true));',
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, runnerPath, relTest };
};

const parseHeader = (stdout) => {
  const line = stdout.split(/\r?\n/).find((row) => row.trim());
  if (!line) throw new Error("Runner header missing.");
  return JSON.parse(line);
};

const resolveProofPath = (root, proofPath) =>
  path.join(root, ...proofPath.split("/"));

const waitForFile = async (filePath, timeoutMs) => {
  const start = Date.now();
  while (true) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout waiting for ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

test("runner barrier ignored unless explicitly enabled", async () => {
  const fixture = await setupFixture();
  const barrierRel = ".ato/tmp/barrier";
  try {
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, fixture.relTest],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: sanitizeEnv({
          ...process.env,
          ATO_RUNNER_BARRIER_DIR: barrierRel,
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const header = parseHeader(result.stdout);
    const proofPath = resolveProofPath(fixture.root, header.proof_path);
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
    assert.equal(proof.barrier_used, false);
    assert.equal(proof.barrier_ignored, true);
    assert.equal(proof.barrier_result, "ignored");
    assert.equal(proof.barrier_dir, barrierRel);
    await assert.rejects(
      fs.stat(path.join(fixture.root, barrierRel, "ready.json")),
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner barrier handshake waits for continue.json", async () => {
  const fixture = await setupFixture();
  const barrierRel = ".ato/tmp/barrier";
  const barrierDir = path.join(fixture.root, ".ato", "tmp", "barrier");
  const readyPath = path.join(barrierDir, "ready.json");
  const continuePath = path.join(barrierDir, "continue.json");
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  try {
    child = spawn(process.execPath, [fixture.runnerPath, fixture.relTest], {
      cwd: fixture.root,
      env: sanitizeEnv({
        ...process.env,
        ATO_RUNNER_BARRIER_DIR: barrierRel,
        ATO_RUNNER_BARRIER_ENABLE: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForFile(readyPath, 20000);
    const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
    assert.ok(ready.invocation_id);
    assert.equal(ready.discovered_test_count, 1);
    await fs.writeFile(
      continuePath,
      `${JSON.stringify({ invocation_id: ready.invocation_id })}\n`,
      "utf8",
    );

    const result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code }));
    });
    assert.equal(result.code, 0, stderr || stdout);
    const header = parseHeader(stdout);
    const proofPath = resolveProofPath(fixture.root, header.proof_path);
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
    assert.equal(proof.barrier_used, true);
    assert.equal(proof.barrier_ignored, false);
    assert.equal(proof.barrier_result, "ok");
    assert.equal(proof.barrier_dir, barrierRel);
    assert.equal(proof.barrier_timeout_ms, 20000);
    assert.equal(proof.barrier_poll_ms, 50);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner barrier timeout reports stable reason", async () => {
  const fixture = await setupFixture();
  const barrierRel = ".ato/tmp/barrier";
  try {
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, fixture.relTest],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: sanitizeEnv({
          ...process.env,
          ATO_RUNNER_BARRIER_DIR: barrierRel,
          ATO_RUNNER_BARRIER_ENABLE: "1",
          ATO_RUNNER_BARRIER_TIMEOUT_MS: "5",
          ATO_RUNNER_BARRIER_POLL_MS: "5",
        }),
      },
    );
    const observed = (result.stderr || result.stdout || "").trim();
    assert.notEqual(result.status, 0);
    assert.match(observed, /runner_barrier_timeout/);
    const proofDir = path.join(fixture.root, ".ato", "runs", "runner-proof");
    const entries = await fs.readdir(proofDir);
    const proofName = entries.find(
      (entry) => entry.endsWith(".json") && !entry.startsWith("receipts-"),
    );
    assert.ok(proofName);
    const proof = JSON.parse(
      await fs.readFile(path.join(proofDir, proofName), "utf8"),
    );
    assert.equal(proof.barrier_used, true);
    assert.equal(proof.barrier_result, "runner_barrier_timeout");
    assert.equal(proof.barrier_timeout_ms, 5);
    assert.equal(proof.barrier_poll_ms, 5);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
