import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sanitizeEnv = (env) => {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST")) {
      delete next[key];
    }
    if (key === "ATO_TEST_SHARD") {
      delete next[key];
    }
  }
  return next;
};

const setupFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-runner-hash-"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  const relTest = "test/fixture.test.js";
  await fs.mkdir(path.join(root, "test"), { recursive: true });
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

const loadHelpers = async (runnerPath) => {
  const moduleUrl = pathToFileURL(runnerPath).href;
  const module = await import(moduleUrl);
  return {
    computeTestContentSha256: module.computeTestContentSha256,
  };
};

test("runner receipts include exec-time before/after hashes", async () => {
  const fixture = await setupFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, fixture.relTest],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: sanitizeEnv({ ...process.env, ATO_TEST_CONCURRENCY: "1" }),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const header = parseHeader(result.stdout);
    const receiptsPath = resolveProofPath(fixture.root, header.receipts_path);
    const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
    const receipts = receiptsRaw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, 1);
    const entry = receipts[0];
    assert.ok(entry.test_content_sha256_before);
    assert.ok(entry.test_content_sha256_after);
    assert.equal(entry.test_content_sha256_before, entry.test_content_sha256_after);
    assert.equal(entry.content_hash_method, "sha256(file_bytes)");
    const { computeTestContentSha256 } = await loadHelpers(fixture.runnerPath);
    const expected = computeTestContentSha256(
      path.join(fixture.root, fixture.relTest),
      fixture.root,
    );
    assert.equal(entry.test_content_sha256_before, expected);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
