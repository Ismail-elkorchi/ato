import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const sanitizeEnv = (env) => {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST")) {
      delete next[key];
    }
  }
  return next;
};

const setupFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-runner-env-"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const relTest = "test/barrier-env-strip.test.js";
  await fs.writeFile(
    path.join(root, relTest),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'const blocked = [',
      '  "ATO_RUNNER_BARRIER_DIR",',
      '  "ATO_RUNNER_BARRIER_ENABLE",',
      '  "ATO_RUNNER_BARRIER_TIMEOUT_MS",',
      '  "ATO_RUNNER_BARRIER_POLL_MS",',
      '].filter((key) => key in process.env);',
      'test("barrier env stripped", () => {',
      "  assert.deepEqual(blocked, []);",
      "});",
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

test("runner strips barrier env from child processes", async () => {
  const fixture = await setupFixture();
  const barrierRel = ".ato/tmp/barrier";
  const barrierDir = path.join(fixture.root, ".ato", "tmp", "barrier");
  const readyPath = path.join(barrierDir, "ready.json");
  const continuePath = path.join(barrierDir, "continue.json");
  try {
    const child = spawn(process.execPath, [fixture.runnerPath, fixture.relTest], {
      cwd: fixture.root,
      env: sanitizeEnv({
        ...process.env,
        ATO_RUNNER_BARRIER_DIR: barrierRel,
        ATO_RUNNER_BARRIER_ENABLE: "1",
        ATO_RUNNER_BARRIER_TIMEOUT_MS: "20000",
        ATO_RUNNER_BARRIER_POLL_MS: "50",
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
    assert.deepEqual(proof.sanitized_env_keys, [
      "ATO_RUNNER_BARRIER_DIR",
      "ATO_RUNNER_BARRIER_ENABLE",
      "ATO_RUNNER_BARRIER_POLL_MS",
      "ATO_RUNNER_BARRIER_TIMEOUT_MS",
    ]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
