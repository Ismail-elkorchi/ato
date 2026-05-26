import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
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
    gates: {
      fast: [],
      full: {
        tests: {
          order: ["root"],
          root: [{ id: "tests", cmd: ["npm", "run", "test"] }],
        },
      },
    },
  });
};

const writeContracts = async (root) => {
  const docPath = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await fs.mkdir(path.dirname(docPath), { recursive: true });
  await fs.writeFile(docPath, "# PLATFORM\n\n## 0 Purpose\n", "utf8");
  const indexPath = path.join(root, ".ato", "cache", "contracts.index.json");
  const entryId = "0-purpose-1";
  const index = {
    version: 1,
    generated_at: "2025-01-01T00:00:00.000Z",
    docs: [
      {
        doc: docPath,
        entries: [
          {
            id: entryId,
            heading: "0 Purpose",
            path: "PLATFORM_CONTRACT / 0 Purpose",
            anchor: "0-purpose",
            sectionNumber: "0",
            aliases: ["§0", "0"],
            level: 2,
            lineStart: 1,
            lineEnd: 2,
          },
        ],
      },
    ],
    lookup: {
      [`${docPath}::§0`]: { doc: docPath, entryId },
      [`${docPath}::0`]: { doc: docPath, entryId },
    },
  };
  await writeJson(indexPath, index);
};

const writeBlock = async (root, { baselineTag }) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0006.json"), {
    version: 1,
    blockId: "block-0006",
    baseline: { tag: baselineTag },
    rules: {
      evidenceRequired: true,
      negativeReportRequired: true,
    },
    holdout: {
      version: 1,
      tasks: [
        {
          id: "holdout-target-resolve",
          cmd: [process.execPath, "-e", "process.exit(0)"],
        },
      ],
    },
  });
};

const writeBaseline = async (root, { tag }) => {
  const artifactsDir = path.join(root, ".ato", "runs", "artifacts", "global", "gate");
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactPath = path.join(artifactsDir, "lint-1.log");
  await fs.writeFile(artifactPath, "baseline ok", "utf8");
  const artifactSha = crypto
    .createHash("sha256")
    .update("baseline ok")
    .digest("hex");

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
        path: ".ato/runs/artifacts/global/gate/lint-1.log",
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

const writePackage = async (root, version) => {
  await writeJson(path.join(root, "package.json"), {
    name: "cycle-proof-fixture",
    type: "module",
    version,
    scripts: {
      test: "node scripts/parallel-runner.mjs test/*.test.js",
    },
  });
};

const writeRunner = async (root) => {
  const source = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, source, "utf8");
  return runnerPath;
};

const writeTests = async (root) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(
    path.join(testDir, "fixture.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("fixture ok", () => assert.ok(true));',
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(testDir, "parallelism-proof.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("parallelism fixture ok", () => assert.ok(true));',
      "",
    ].join("\n"),
    "utf8",
  );
};

const makeQueueItem = ({ id, title }) => ({
  id,
  title,
  type: "tooling",
  status: "queued",
  priority: "P2",
  tags: [],
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  target: { selector: "range", value: "0.1.x" },
  deps: [],
  evidence: [],
  owner: "agent",
  notes: "",
  spec: {
    problem: "problem",
    outcome: "outcome",
    plan: {
      steps: ["step"],
    },
    acceptance_criteria: ["cmd:node -e process.exit(0)"],
    inputs: ["output:seed"],
    deliverables: ["deliverable"],
    scope: [],
    risks: [],
    contract_refs: ["§0"],
    runbook: [],
  },
});

const writeQueue = async (root) => {
  const items = [
    makeQueueItem({ id: "BL-0002", title: "block-0006: second queued item" }),
    makeQueueItem({ id: "BL-0001", title: "block-0006: first queued item" }),
  ];
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), items);
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

const resolveTestArgs = async (root) => {
  const testDir = path.join(root, "test");
  const entries = await fs.readdir(testDir);
  return entries
    .filter((entry) => entry.endsWith(".test.js"))
    .map((entry) => `test/${entry}`)
    .sort((a, b) => a.localeCompare(b));
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

const runCycleStart = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-proof-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-test";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  const runnerPath = await writeRunner(root);
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  await writePackage(root, pkg.version);
  await writeTests(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const selectionPath = path.join(
    root,
    ".ato",
    "cycles",
    payload.cycle_id,
    "selection.json",
  );
  const selectionRaw = await fs.readFile(selectionPath, "utf8");
  return { root, selectionRaw, runnerPath };
};

const loadProofHelpers = async (runnerPath) => {
  const moduleUrl = pathToFileURL(runnerPath).href;
  const module = await import(moduleUrl);
  return {
    computeArgvFingerprint: module.computeArgvFingerprint,
    computeProofSecretHash: module.computeProofSecretHash,
    computeReceiptHash: module.computeReceiptHash,
  };
};

test("cycle cycle start is deterministic and gate proof binds receipts", async () => {
  const first = await runCycleStart();
  const second = await runCycleStart();
  assert.equal(first.selectionRaw, second.selectionRaw);

  const cliPath = path.resolve("dist/cli/main.js");
  const gate = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "full", "--json"],
    {
      cwd: first.root,
      encoding: "utf8",
      env: { ...process.env, ATO_TEST_CONCURRENCY: "2", ATO_TEST_SHARD: "" },
    },
  );
  assert.equal(gate.status, 0, gate.stderr);
  const payload = JSON.parse(gate.stdout.trim());
  assert.equal(payload.ok, true);
  const artifactPath =
    payload.results?.find((res) => res.id === "tests")?.artifact ??
    payload.results?.[0]?.artifact;
  assert.ok(artifactPath);
  const resolvedArtifactPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(first.root, ...artifactPath.split("/"));
  const artifact = await fs.readFile(resolvedArtifactPath, "utf8");
  const headerLine =
    artifact
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("{") && line.includes("\"runner_id\"")) ??
    null;
  assert.ok(headerLine);
  const header = JSON.parse(headerLine);

  const {
    computeArgvFingerprint,
    computeProofSecretHash,
    computeReceiptHash,
  } = await loadProofHelpers(first.runnerPath);
  const runnerSha = crypto
    .createHash("sha256")
    .update(await fs.readFile(first.runnerPath))
    .digest("hex");
  const args = await resolveTestArgs(first.root);
  const invocationId = computeInvocationId({
    runnerSha,
    concurrency: 2,
    source: "env",
    args,
  });
  const argvFingerprint = computeArgvFingerprint(args);
  const proofSecretHash = computeProofSecretHash({
    argvFingerprint,
    runnerSha256: runnerSha,
    invocationId,
  });
  assert.equal(header.invocation_id, invocationId);
  assert.equal(header.proof_secret_hash, proofSecretHash);
  assert.ok(header.proof_path);
  assert.ok(header.receipts_path);

  const receiptsPath = path.join(first.root, ...header.receipts_path.split("/"));
  const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
  const receipts = receiptsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receiptMap = new Map(receipts.map((entry) => [entry.test_file, entry]));
  for (const testFile of args) {
    const entry = receiptMap.get(testFile);
    assert.ok(entry, `missing receipt for ${testFile}`);
    const expectedHash = computeReceiptHash({
      proofSecretHash,
      runnerSha256: runnerSha,
      invocationId,
      testFileId: entry.test_file_id,
    });
    assert.equal(entry.receipt_hash, expectedHash);
  }
});
