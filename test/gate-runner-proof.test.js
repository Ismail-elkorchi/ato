import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

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

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const hashString = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const computePathHash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const computeInvocationId = ({ runnerSha, concurrency, source, args }) => {
  const payload = JSON.stringify({
    runner_sha256: runnerSha,
    source,
    concurrency,
    args,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
};

const resolveTestArgs = async (root) => {
  const testDir = path.join(root, "test");
  const entries = await fs.readdir(testDir);
  return entries
    .filter((entry) => entry.endsWith(".test.js"))
    .map((entry) => `test/${entry}`)
    .sort((a, b) => a.localeCompare(b));
};

const resolveProofPath = (root, proofPath) => {
  const segments = proofPath.split("/");
  return path.join(root, ...segments);
};

const normalizeRealpathForCompare = (value) => {
  const normalized = String(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const realpathNative = async (value) => {
  if (typeof fs.realpath.native === "function") {
    return fs.realpath.native(value);
  }
  return fs.realpath(value);
};

const resolveRealpathInfo = async (root, testFile) => {
  const rootReal = await realpathNative(root);
  const fileReal = await realpathNative(path.join(root, testFile));
  const rootNormalized = normalizeRealpathForCompare(rootReal);
  const fileNormalized = normalizeRealpathForCompare(fileReal);
  if (process.platform === "win32") {
    const rootDrive = rootNormalized.slice(0, 2);
    const fileDrive = fileNormalized.slice(0, 2);
    if (
      /^[a-z]:$/.test(rootDrive) &&
      /^[a-z]:$/.test(fileDrive) &&
      rootDrive !== fileDrive
    ) {
      const payload = {
        test_file: testFile,
        resolved_realpath_hash: computePathHash(fileReal),
        resolved_realpath_hash_method: "sha256(path_string)",
      };
      throw new Error(`test_path_escapes_repo ${JSON.stringify(payload)}`);
    }
  }
  const rel = path.posix.relative(rootNormalized, fileNormalized);
  if (!rel) {
    return { realpath: fileReal, realpathHash: computePathHash(fileReal) };
  }
  if (path.posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    const payload = {
      test_file: testFile,
      resolved_realpath_hash: computePathHash(fileReal),
      resolved_realpath_hash_method: "sha256(path_string)",
    };
    throw new Error(`test_path_escapes_repo ${JSON.stringify(payload)}`);
  }
  return { realpath: fileReal, realpathHash: computePathHash(fileReal) };
};

const sanitizeEnv = (env) => {
  const next = { ...env };
  const stripKeys = new Set([
    "TMPDIR",
    "ATO_TEST_TMPDIR",
    "ATO_TEST_TMPDIR_SOURCE",
    "ATO_TEST_SHARD",
  ]);
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST") || stripKeys.has(key)) {
      delete next[key];
    }
  }
  return next;
};

const gateEnv = (overrides) => {
  const base = sanitizeEnv(process.env);
  return { ...base, ...(overrides ?? {}) };
};

const repoDefaultTempEnv = {
  TMPDIR: ".ato/tmp",
  ATO_TEST_TMPDIR_SOURCE: "repo_default",
};

const parseRunnerHeader = (artifact) => {
  const headerLine =
    artifact
      .split(/\r?\n/)
      .find(
        (line) => line.trim().startsWith("{") && line.includes("\"runner_id\""),
      ) ?? null;
  if (!headerLine) {
    throw new Error("Runner header missing in gate artifact.");
  }
  return JSON.parse(headerLine);
};

const loadProofHelpers = async (runnerPath) => {
  const moduleUrl = pathToFileURL(runnerPath).href;
  const module = await import(moduleUrl);
  return {
    computeArgvFingerprint: module.computeArgvFingerprint,
    computeProofSecretHash: module.computeProofSecretHash,
    computeReceiptHash: module.computeReceiptHash,
    computeTestFileId: module.computeTestFileId,
    computeTestContentSha256: module.computeTestContentSha256,
    resolveTempBinding: module.resolveTempBinding,
  };
};

const writeNegativeEvidence = async ({
  caseId,
  expectedFailReason,
  observedFailReason,
  runnerPath,
  proofPath,
  receiptsPath,
  input,
  extra,
  invocationId,
}) => {
  try {
    const stateRaw = await fs.readFile(
      path.resolve(".ato", "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateRaw);
    const cycleId = state?.activeCycleId;
    if (!cycleId) return;
    const evidencePath = path.join(
      process.cwd(),
      ".ato",
      "cycles",
      cycleId,
      `acceptance-negcontrol-${caseId}.json`,
    );
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    const runnerSha = runnerPath ? await hashFile(runnerPath).catch(() => null) : null;
    const proofSha = proofPath ? await hashFile(proofPath).catch(() => null) : null;
    const receiptsSha = receiptsPath
      ? await hashFile(receiptsPath).catch(() => null)
      : null;
    const payload = {
      case_id: caseId,
      expected_fail_reason: expectedFailReason,
      observed_fail_reason: observedFailReason,
      runner_sha256: runnerSha,
      proof_sha256: proofSha,
      receipts_sha256: receiptsSha,
      input_sha256: input ? hashString(input) : null,
      invocation_id: invocationId ?? null,
      ...(extra ?? {}),
    };
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // ignore evidence write failures in tests
  }
};

const writeTempSourceMismatchEvidence = async ({
  tmpdir,
  flag,
  observedTempSource,
  reasonCode,
}) => {
  try {
    const stateRaw = await fs.readFile(path.resolve(".ato", "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    const cycleId = state?.activeCycleId;
    if (!cycleId) return;
    const evidencePath = path.join(
      process.cwd(),
      ".ato",
      "cycles",
      cycleId,
      "acceptance-negcontrol-temp-source-mismatch.json",
    );
    const payload = {
      case_id: "temp-source-mismatch",
      tmpdir_hash: tmpdir ? hashString(tmpdir) : null,
      tmpdir_hash_method: "sha256",
      flag,
      observed_temp_source: observedTempSource,
      reason_code: reasonCode,
    };
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // ignore evidence write failures in tests
  }
};

const assertGateRunnerProof = async ({ root, artifactPath, env }) => {
  const resolvedArtifactPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(root, artifactPath);
  const artifact = await fs.readFile(resolvedArtifactPath, "utf8");
  const header = parseRunnerHeader(artifact);
  if (!header.proof_path || !header.receipts_path) {
    throw new Error("Runner header missing proof_path or receipts_path.");
  }
  if (path.isAbsolute(header.proof_path)) {
    throw new Error("Runner header proof_path must be relative.");
  }
  if (path.isAbsolute(header.receipts_path)) {
    throw new Error("Runner header receipts_path must be relative.");
  }

  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  const {
    computeArgvFingerprint,
    computeProofSecretHash,
    computeReceiptHash,
    computeTestFileId,
    computeTestContentSha256,
    resolveTempBinding,
  } = await loadProofHelpers(runnerPath);
  const runnerSha = await hashFile(runnerPath);
  const args = await resolveTestArgs(root);
  const invocationId = computeInvocationId({
    runnerSha,
    concurrency: header.concurrency,
    source: header.source,
    args,
  });
  const argvFingerprint = computeArgvFingerprint(args);
  const proofSecretHash = computeProofSecretHash({
    argvFingerprint,
    runnerSha256: runnerSha,
    invocationId,
  });
  const expectedTemp = resolveTempBinding({
    baseDir: root,
    env: env ?? {},
    invocationId,
    ensureDir: false,
  });

  const assertTempBinding = (label, record) => {
    if (!record) {
      throw new Error(`Missing temp binding in ${label}.`);
    }
    if (record.temp_root && path.isAbsolute(record.temp_root)) {
      throw new Error("temp_root_absolute_path");
    }
    if (record.temp_run_dir && path.isAbsolute(record.temp_run_dir)) {
      throw new Error("temp_run_dir_absolute_path");
    }
    if (record.temp_root_hash_method !== "sha256(path_string)") {
      throw new Error("temp_root_hash_method_mismatch");
    }
    if (record.temp_run_dir_hash_method !== "sha256(path_string)") {
      throw new Error("temp_run_dir_hash_method_mismatch");
    }
    const expected = {
      temp_root: expectedTemp.temp_root,
      temp_root_hash: expectedTemp.temp_root_hash,
      temp_source: expectedTemp.temp_source,
      temp_source_reason: expectedTemp.temp_source_reason ?? null,
      temp_run_dir: expectedTemp.temp_run_dir,
      temp_run_dir_sha256: expectedTemp.temp_run_dir_sha256,
    };
    const observed = {
      temp_root: record.temp_root ?? null,
      temp_root_hash: record.temp_root_hash ?? null,
      temp_source: record.temp_source ?? null,
      temp_source_reason: record.temp_source_reason ?? null,
      temp_run_dir: record.temp_run_dir ?? null,
      temp_run_dir_sha256: record.temp_run_dir_sha256 ?? null,
    };
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      throw new Error(
        `proof_temp_root_mismatch ${JSON.stringify({ label, expected, observed })}`,
      );
    }
  };

  if (header.runner_id !== "ato-parallel-runner") {
    throw new Error("Runner header runner_id mismatch.");
  }
  if (header.runner_sha256 !== runnerSha) {
    throw new Error("Runner header runner_sha256 mismatch.");
  }
  if (header.invocation_id !== invocationId) {
    throw new Error("Runner header invocation_id mismatch.");
  }
  if (header.proof_secret_hash !== proofSecretHash) {
    throw new Error("Runner header proof_secret_hash mismatch.");
  }
  assertTempBinding("runner header", header);

  const proofPath = resolveProofPath(root, header.proof_path);
  const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
  if (proof.proof_kind !== "runner_exec.v1") {
    throw new Error("Runner proof_kind mismatch.");
  }
  if (proof.runner_sha256 !== runnerSha) {
    throw new Error("Runner proof runner_sha256 mismatch.");
  }
  if (proof.invocation_id !== invocationId) {
    throw new Error("Runner proof invocation_id mismatch.");
  }
  if (proof.proof_secret_hash !== proofSecretHash) {
    throw new Error("Runner proof_secret_hash mismatch.");
  }
  assertTempBinding("runner proof", proof);

  const receiptsPath = resolveProofPath(root, header.receipts_path);
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receiptMap = new Map();
  const duplicates = [];
  for (const entry of receipts) {
    if (receiptMap.has(entry.test_file)) {
      duplicates.push(entry.test_file);
    }
    receiptMap.set(entry.test_file, entry);
  }
  if (duplicates.length) {
    throw new Error(`Duplicate receipt entry for ${duplicates[0]}.`);
  }
  const extras = [...receiptMap.keys()].filter((file) => !args.includes(file));
  if (extras.length) {
    throw new Error(`Unexpected receipt entry for ${extras[0]}.`);
  }
  for (const testFile of args) {
    const testFileId = computeTestFileId(path.join(root, testFile), root);
    const expectedHash = computeReceiptHash({
      proofSecretHash,
      runnerSha256: runnerSha,
      invocationId,
      testFileId,
    });
    const entry = receiptMap.get(testFile);
    if (!entry) {
      throw new Error(`Missing receipt for ${testFile}.`);
    }
    if (entry.receipt_hash !== expectedHash) {
      throw new Error(`Receipt hash mismatch for ${testFile}.`);
    }
    if (entry.resolved_realpath_hash_method !== "sha256(path_string)") {
      throw new Error("receipt_realpath_hash_method_mismatch");
    }
    const realpathInfo = await resolveRealpathInfo(root, testFile);
    if (entry.resolved_realpath_hash !== realpathInfo.realpathHash) {
      throw new Error("receipt_realpath_hash_mismatch");
    }
    if (!entry.test_content_sha256_before) {
      throw new Error("receipt_content_hash_before_missing");
    }
    if (!entry.test_content_sha256_after) {
      throw new Error("receipt_content_hash_after_missing");
    }
    if (entry.content_hash_method !== "sha256(file_bytes)") {
      throw new Error("receipt_content_hash_method_mismatch");
    }
    if (entry.test_content_sha256_before !== entry.test_content_sha256_after) {
      const diff = {
        test_file_id: entry.test_file_id ?? testFileId,
        before: entry.test_content_sha256_before,
        after: entry.test_content_sha256_after,
      };
      throw new Error(
        `test_file_mutated_during_execution ${JSON.stringify(diff)}`,
      );
    }
    const expectedContent = computeTestContentSha256(
      path.join(root, testFile),
      root,
    );
    if (entry.test_content_sha256_before !== expectedContent) {
      const diff = {
        test_file_id: entry.test_file_id ?? testFileId,
        expected: expectedContent,
        observed: entry.test_content_sha256_before,
        method: entry.content_hash_method,
      };
      throw new Error(
        `receipt_content_hash_mismatch ${JSON.stringify(diff)}`,
      );
    }
    if (entry.test_content_sha256_after !== expectedContent) {
      const diff = {
        test_file_id: entry.test_file_id ?? testFileId,
        expected: expectedContent,
        observed: entry.test_content_sha256_after,
        method: entry.content_hash_method,
      };
      throw new Error(
        `receipt_content_hash_mismatch ${JSON.stringify(diff)}`,
      );
    }
    assertTempBinding(`receipt ${entry.test_file}`, entry);
  }

  return header;
};

const setupGateFixture = async ({ tests } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-runner-"));
  await writeAgents(root);

  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");

  await writeJson(path.join(root, "package.json"), {
    name: "gate-runner-fixture",
    type: "module",
    version: "0.0.0-test",
    scripts: {
      test: "node scripts/parallel-runner.mjs test/*.test.js",
    },
  });

  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const defaultTests = {
    "fixture.test.js": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("fixture ok", () => assert.ok(true));',
      "",
    ].join("\n"),
    "parallelism-proof.test.js": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("parallelism fixture ok", () => assert.ok(true));',
      "",
    ].join("\n"),
  };
  const entries = tests ?? defaultTests;
  for (const [name, content] of Object.entries(entries)) {
    await fs.writeFile(path.join(testDir, name), content, "utf8");
  }

  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "gate-proof-seed",
    gates: {
      full: {
        tests: {
          order: ["root"],
          root: [{ id: "tests", cmd: ["npm", "run", "test"] }],
        },
      },
    },
  });

  initGit(root);
  commitAll(root);
  return root;
};

const setupRawGateFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-raw-"));
  await writeAgents(root);

  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");

  await writeJson(path.join(root, "package.json"), {
    name: "gate-raw-fixture",
    type: "module",
    version: "0.0.0-test",
    scripts: {
      test: "node scripts/parallel-runner.mjs test/*.test.js",
    },
  });

  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(
    path.join(testDir, "forge-proof.test.js"),
    [
      'import { test } from "node:test";',
      'import { promises as fs } from "node:fs";',
      'import path from "node:path";',
      'test("forge proof artifacts", async () => {',
      '  const proofDir = path.join(process.cwd(), ".ato", "runs", "runner-proof");',
      "  await fs.mkdir(proofDir, { recursive: true });",
      '  const invocationId = "forged-invocation";',
      "  const proofPath = path.join(proofDir, `${invocationId}.json`);",
      "  const receiptsPath = path.join(proofDir, `receipts-${invocationId}.jsonl`);",
      "  await fs.writeFile(",
      "    proofPath,",
      '    `${JSON.stringify({ proof_kind: "runner_exec.v1", invocation_id: invocationId })}\\n`,',
      "    \"utf8\",",
      "  );",
      "  await fs.writeFile(receiptsPath, \"\", \"utf8\");",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "gate-proof-seed",
    gates: {
      full: {
        tests: {
          order: ["root"],
          root: [{ id: "tests", cmd: ["node", "--test", "test/*.test.js"] }],
        },
      },
    },
  });

  initGit(root);
  commitAll(root);
  return root;
};

const getSharedGateRun = (() => {
  let cached = null;
  return async () => {
    if (cached) return cached;
    const root = await setupGateFixture();
    const cliPath = path.resolve("dist/cli/main.js");
    const expectedEnv = {
      ...gateEnv({ ATO_TEST_CONCURRENCY: "1" }),
      ...repoDefaultTempEnv,
    };
    const result = spawnSync(
      process.execPath,
      [cliPath, "gate", "run", "--mode", "full", "--json"],
      { cwd: root, encoding: "utf8", env: gateEnv({ ATO_TEST_CONCURRENCY: "1" }) },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    const artifactPath =
      payload.results?.find((res) => res.artifact)?.artifact ??
      payload.results?.[0]?.artifact;
    assert.ok(artifactPath);
    const artifactAbsPath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.join(root, artifactPath);
    const artifact = await fs.readFile(artifactAbsPath, "utf8");
    const header = parseRunnerHeader(artifact);
    const receiptsPath = resolveProofPath(root, header.receipts_path);
    const proofPath = resolveProofPath(root, header.proof_path);
    const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
    const proofRaw = await fs.readFile(proofPath, "utf8");
    cached = {
      root,
      artifactPath,
      header,
      expectedEnv,
      receiptsPath,
      proofPath,
      receiptsRaw,
      proofRaw,
      reset: async () => {
        await fs.writeFile(receiptsPath, receiptsRaw, "utf8");
        await fs.writeFile(proofPath, proofRaw, "utf8");
      },
    };
    return cached;
  };
})();

test("gate run artifacts prove canonical runner executed", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const header = await assertGateRunnerProof({
    root: shared.root,
    artifactPath: shared.artifactPath,
    env: shared.expectedEnv,
  });
  assert.equal(header.runner_version, "0.0.0-test");
  assert.equal(header.concurrency, 1);
  assert.equal(header.source, "env");
  assert.ok(!header.proof_path.includes("\\"));
  assert.equal(header.temp_source, "repo_default");
  assert.equal(header.temp_root, ".ato/tmp");
});

test("gate proof rejects temp_source spoofed flag when TMPDIR is external", async () => {
  const root = await setupGateFixture();
  const candidate = path.join(os.tmpdir(), "ato-temp-source-mismatch");
  const rel = path.relative(root, candidate);
  const externalTmp =
    rel && (rel.startsWith("..") || path.isAbsolute(rel))
      ? candidate
      : path.join(path.dirname(root), "ato-temp-source-mismatch");
  await fs.mkdir(externalTmp, { recursive: true });
  const env = gateEnv({
    TMPDIR: externalTmp,
    ATO_TEST_TMPDIR_SOURCE: "repo_default",
    ATO_TEST_CONCURRENCY: "1",
  });

  const runnerResult = spawnSync(
    process.execPath,
    ["scripts/parallel-runner.mjs", "test/*.test.js"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(runnerResult.status, 0, runnerResult.stderr);

  const artifactPath = path.join(
    root,
    ".ato",
    "runs",
    "artifacts",
    "global",
    "gate",
    "runner-direct.log",
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, runnerResult.stdout, "utf8");

  const header = await assertGateRunnerProof({
    root,
    artifactPath,
    env,
  });
  assert.equal(header.temp_source, "env:TMPDIR");
  assert.equal(header.temp_source_reason, "source_flag_mismatch_ignored");
  await writeTempSourceMismatchEvidence({
    tmpdir: externalTmp,
    flag: "repo_default",
    observedTempSource: header.temp_source ?? null,
    reasonCode: header.temp_source_reason ?? null,
  });
});

test("gate proof rejects raw node --test even with forged proof files", async () => {
  const root = await setupRawGateFixture();
  const cliPath = path.resolve("dist/cli/main.js");
  const expectedEnv = { ...gateEnv(), ...repoDefaultTempEnv };
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "full", "--json"],
    { cwd: root, encoding: "utf8", env: gateEnv() },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const artifactPath =
    payload.results?.find((res) => res.artifact)?.artifact ??
    payload.results?.[0]?.artifact;
  assert.ok(artifactPath);
  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject raw node --test run.");
  } catch (error) {
    const expected = "Runner header missing in gate artifact.";
    const observed = String(error);
    await writeNegativeEvidence({
      caseId: "raw-node-test",
      expectedFailReason: expected,
      observedFailReason: observed,
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      input: "raw-node-test",
    });
    assert.match(observed, /Runner header missing/);
  }
});

test("gate proof rejects tampered receipt hash", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  receipts[0].receipt_hash = "tampered";
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject tampered receipts.");
  } catch (error) {
    const expected = `Receipt hash mismatch for ${receipts[0].test_file}.`;
    await writeNegativeEvidence({
      caseId: "receipt-tamper",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: JSON.stringify(receipts[0]),
    });
    assert.match(String(error), /Receipt hash mismatch/);
  }
});

test("gate proof rejects missing receipt entry", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const removed = receipts.shift();
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject missing receipt.");
  } catch (error) {
    const expected = `Missing receipt for ${removed.test_file}.`;
    await writeNegativeEvidence({
      caseId: "receipt-missing",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: JSON.stringify(removed),
    });
    assert.match(String(error), /Missing receipt/);
  }
});

test("gate proof rejects extra receipt entry", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const extra = {
    receipt_kind: "runner_exec_receipt.v1",
    invocation_id: "extra",
    runner_sha256: "extra",
    test_file: "test/ghost.test.js",
    test_file_id: "extra",
    receipt_hash: "extra",
  };
  receipts.push(extra);
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject extra receipt.");
  } catch (error) {
    const expected = `Unexpected receipt entry for ${extra.test_file}.`;
    await writeNegativeEvidence({
      caseId: "receipt-extra",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: JSON.stringify(extra),
    });
    assert.match(String(error), /Unexpected receipt entry/);
  }
});

test("gate proof rejects swapped receipt hashes", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (receipts.length < 2) {
    throw new Error("Expected at least 2 receipts.");
  }
  const firstHash = receipts[0].receipt_hash;
  receipts[0].receipt_hash = receipts[1].receipt_hash;
  receipts[1].receipt_hash = firstHash;
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject swapped receipts.");
  } catch (error) {
    const expected = `Receipt hash mismatch for ${receipts[0].test_file}.`;
    await writeNegativeEvidence({
      caseId: "receipt-swapped",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: `${receipts[0].test_file}:${receipts[1].test_file}`,
    });
    assert.match(String(error), /Receipt hash mismatch/);
  }
});

test("gate proof rejects duplicate receipt entries", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  receipts.push({ ...receipts[0] });
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject duplicate receipts.");
  } catch (error) {
    const expected = `Duplicate receipt entry for ${receipts[0].test_file}.`;
    await writeNegativeEvidence({
      caseId: "receipt-duplicate",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: JSON.stringify(receipts[0]),
    });
    assert.match(String(error), /Duplicate receipt entry/);
  }
});

test("gate proof rejects mismatched temp binding between proof and receipts", async () => {
  const shared = await getSharedGateRun();
  await shared.reset();
  const { root, artifactPath, expectedEnv, receiptsPath, header } = shared;
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  receipts[0].temp_root_hash = "tampered";
  await fs.writeFile(
    receiptsPath,
    `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected gate proof to reject temp binding mismatch.");
  } catch (error) {
    const expected = "proof_temp_root_mismatch";
    await writeNegativeEvidence({
      caseId: "temp-root-mismatch",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: JSON.stringify(receipts[0]),
    });
    assert.match(String(error), /proof_temp_root_mismatch/);
  }
});

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

const runGateSync = ({ root, env }) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const proc = spawnSync(process.execPath, [
    cliPath,
    "gate",
    "run",
    "--mode",
    "full",
    "--json",
  ], {
    cwd: root,
    encoding: "utf8",
    env: sanitizeEnv({ ...(env ?? process.env), ATO_TEST_SHARD: "" }),
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
};

test("runner detects test file mutation during execution (TOCTOU)", async () => {
  const root = await setupGateFixture({
    tests: {
      "toctou-target.test.js": [
        'import { test } from "node:test";',
        'import { promises as fs } from "node:fs";',
        'import path from "node:path";',
        'import { setTimeout as delay } from "node:timers/promises";',
        "const markerDir = process.env.ATO_TOCTOU_MARKER_DIR;",
        'if (!markerDir) { throw new Error("ATO_TOCTOU_MARKER_DIR missing"); }',
        "const startedPath = path.join(markerDir, \"started.json\");",
        "const continuePath = path.join(markerDir, \"continue.json\");",
        'test("toctou target", async () => {',
        "  await fs.mkdir(markerDir, { recursive: true });",
        "  await fs.writeFile(startedPath, JSON.stringify({ ok: true }), \"utf8\");",
        "  while (true) {",
        "    if (await fs.stat(continuePath).catch(() => null)) break;",
        "    await delay(25);",
        "  }",
        "});",
        "",
      ].join("\n"),
      "helper.test.js": [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("helper ok", () => assert.ok(true));',
        "",
      ].join("\n"),
    },
  });
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  const barrierRel = ".ato/tmp/barrier";
  const barrierDir = path.join(root, ".ato", "tmp", "barrier");
  const readyPath = path.join(barrierDir, "ready.json");
  const continuePath = path.join(barrierDir, "continue.json");
  const markerDir = path.join(root, ".ato", "tmp", "toctou");
  const markerStarted = path.join(markerDir, "started.json");
  const markerContinue = path.join(markerDir, "continue.json");

  const childEnv = {
    ...gateEnv({ TMPDIR: process.env.TMPDIR }),
    ATO_TEST_CONCURRENCY: "2",
    ATO_RUNNER_BARRIER_DIR: barrierRel,
    ATO_RUNNER_BARRIER_ENABLE: "1",
    ATO_TOCTOU_MARKER_DIR: markerDir,
  };
  const child = spawn(process.execPath, [runnerPath, "test/*.test.js"], {
    cwd: root,
    env: childEnv,
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
  const readyPayload = JSON.parse(await fs.readFile(readyPath, "utf8"));
  await fs.writeFile(
    continuePath,
    `${JSON.stringify({ invocation_id: readyPayload.invocation_id })}\n`,
    "utf8",
  );

  await waitForFile(markerStarted, 20000);
  const targetPath = path.join(root, "test", "toctou-target.test.js");
  const beforeSha = await hashFile(targetPath);
  const current = await fs.readFile(targetPath, "utf8");
  await fs.writeFile(
    targetPath,
    `${current}\n// toctou mutation\n`,
    "utf8",
  );
  const afterSha = await hashFile(targetPath);
  await fs.writeFile(markerContinue, "ok", "utf8");

  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });

  const headerLine = stdout.split(/\r?\n/).find((line) => line.trim());
  const header = headerLine ? JSON.parse(headerLine) : null;
  const observed = stderr.trim() || "runner_success";

  const expected = "test_file_mutated_during_execution";
  await writeNegativeEvidence({
    caseId: "toctou",
    expectedFailReason: expected,
    observedFailReason: observed,
    runnerPath,
    proofPath: header?.proof_path
      ? resolveProofPath(root, header.proof_path)
      : null,
    receiptsPath: header?.receipts_path
      ? resolveProofPath(root, header.receipts_path)
      : null,
    input: targetPath,
    invocationId: header?.invocation_id ?? null,
    extra: {
      mutated_file_rel: path
        .relative(root, targetPath)
        .replace(/\\/g, "/"),
      before_sha256: beforeSha,
      after_sha256: afterSha,
      expected_reason: expected,
      observed_reason: observed,
    },
  });

  assert.equal(result.code, 1, stderr || stdout);
  assert.match(observed, /test_file_mutated_during_execution/);
});

test("runner rejects containment escape outside repo root", async (t) => {
  const root = await setupGateFixture();
  const externalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ato-symlink-escape-"),
  );
  const externalFile = path.join(externalDir, "escape.test.js");
  await fs.writeFile(
    externalFile,
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("escape", () => assert.ok(true));',
      "",
    ].join("\n"),
    "utf8",
  );
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const linkDir = path.join(testDir, "escape-link");
  const targetPath = "test/escape-link/escape.test.js";
  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(externalDir, linkDir, linkType);
  } catch {
    if (process.platform === "win32") {
      try {
        await fs.symlink(externalDir, linkDir, "dir");
      } catch {
        t.skip("Symlink/junction escape fixture not supported.");
        return;
      }
    } else {
      t.skip("Symlink escape fixture not supported.");
      return;
    }
  }

  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  const result = spawnSync(
    process.execPath,
    [runnerPath, targetPath],
    {
      cwd: root,
      encoding: "utf8",
      env: gateEnv({ TMPDIR: process.env.TMPDIR }),
    },
  );

  const observed = (result.stderr || result.stdout || "").trim();
  const expected = "test_path_escapes_repo";
  await writeNegativeEvidence({
    caseId: "path-escape",
    expectedFailReason: expected,
    observedFailReason: observed,
    runnerPath,
    input: targetPath,
    extra: {
      expected_reason: expected,
      observed_reason: observed,
    },
  });

  assert.equal(result.status, 1);
  assert.match(observed, /test_path_escapes_repo/);
});

test("gate proof rejects replayed receipts when test content changes", async () => {
  const root = await setupGateFixture();
  const expectedEnv = {
    ...gateEnv({ ATO_TEST_CONCURRENCY: "1" }),
    ...repoDefaultTempEnv,
  };
  const result = runGateSync({
    root,
    env: gateEnv({ ATO_TEST_CONCURRENCY: "1" }),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const artifactPath =
    payload.results?.find((res) => res.artifact)?.artifact ??
    payload.results?.[0]?.artifact;
  assert.ok(artifactPath);

  const targetPath = path.join(root, "test", "fixture.test.js");
  const beforeSha = await hashFile(targetPath);
  const content = await fs.readFile(targetPath, "utf8");
  await fs.writeFile(targetPath, `${content}\n// replay mutation\n`, "utf8");
  const afterSha = await hashFile(targetPath);

  const artifactAbsPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(root, artifactPath);
  const artifact = await fs.readFile(artifactAbsPath, "utf8");
  const header = parseRunnerHeader(artifact);
  const receiptsPath = resolveProofPath(root, header.receipts_path);

  try {
    await assertGateRunnerProof({ root, artifactPath, env: expectedEnv });
    assert.fail("Expected replayed receipts to fail gate proof.");
  } catch (error) {
    const expected = "receipt_content_hash_mismatch";
    await writeNegativeEvidence({
      caseId: "replay",
      expectedFailReason: expected,
      observedFailReason: String(error),
      runnerPath: path.join(root, "scripts", "parallel-runner.mjs"),
      proofPath: resolveProofPath(root, header.proof_path),
      receiptsPath,
      input: targetPath,
      extra: {
        mutated_file_rel: path
          .relative(root, targetPath)
          .replace(/\\/g, "/"),
        before_sha256: beforeSha,
        after_sha256: afterSha,
        expected_reason: expected,
        observed_reason: String(error),
      },
    });
    assert.match(String(error), /receipt_content_hash_mismatch/);
  }
});
