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

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

const resolveTempBase = (repoRoot) => {
  const tmpRoot = os.tmpdir();
  const rel = path.relative(repoRoot, tmpRoot);
  const isInside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isInside) return tmpRoot;
  return path.join(path.dirname(repoRoot), ".ato-test-tmp");
};

const makeTempDir = async (prefix) => {
  const repoRoot = path.resolve(".");
  const base = resolveTempBase(repoRoot);
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, prefix));
};

const writeAgents = async (root) => {
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
};

const writePackageJson = async (root) => {
  await writeJson(path.join(root, "package.json"), {
    name: "ato-cycle-finish-fixture",
    version: "0.0.0",
  });
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
          root: [
            {
              id: "runner",
              cmd: [
                process.execPath,
                "scripts/parallel-runner.mjs",
                "test/sample.test.js",
              ],
            },
          ],
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
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), {
    version: 1,
    blockId: "block-0005",
    baseline: { tag: baselineTag },
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
  const artifactSha = crypto.createHash("sha256").update("baseline ok").digest("hex");

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

const writeQueue = async (root) => {
  const item = {
    id: "BL-0001",
    title: "Block-0005 queued item",
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
    notes: "Completed. Evidence: output:seed",
    spec: {
      problem: "problem",
      outcome: "outcome",
      plan: {
        steps: ["step"],
      },
      acceptance_criteria: ["cmd:ato cycle finish --json"],
      inputs: ["output:seed"],
      deliverables: ["deliverable"],
      scope: [],
      risks: [],
      contract_refs: ["§0"],
      runbook: [],
    },
  };
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [item]);
};

const writeRunner = async (root) => {
  const source = path.resolve("scripts/parallel-runner.mjs");
  const dest = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
};

const writeTestFile = async (root) => {
  const testPath = path.join(root, "test", "sample.test.js");
  await fs.mkdir(path.dirname(testPath), { recursive: true });
  await fs.writeFile(
    testPath,
    [
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "test(\"sample\", () => {",
      "  assert.equal(1, 1);",
      "});",
      "",
    ].join("\n"),
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

const tagBaseline = (root, tag) => {
  const result = spawnSync("git", ["tag", tag], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

const sanitizeEnv = () => {
  const next = { ...process.env };
  delete next["TMPDIR"];
  delete next["ATO_TEST_TMPDIR"];
  delete next["ATO_TEST_TMPDIR_SOURCE"];
  return next;
};

const parseRunnerHeader = (artifact) => {
  const headerLine =
    artifact
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("{") && line.includes("\"runner_id\"")) ??
    null;
  if (!headerLine) {
    throw new Error("Runner header missing in gate artifact.");
  }
  return JSON.parse(headerLine);
};

const runCycleFinish = async ({ envOverrides } = {}) => {
  const root = await makeTempDir("ato-cycle-finish-env-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writePackageJson(root);
  await writeContracts(root);
  await writeRunner(root);
  await writeTestFile(root);
  const baselineTag = "baseline-test";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...sanitizeEnv(), ...(envOverrides ?? {}) };

  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);

  const finish = spawnSync(
    process.execPath,
    [
      cliPath,
      "cycle",
      "finish",
      "--json",
      "--run-acceptance",
      "--run-gate",
      "--run-pack-verify",
    ],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(finish.status, 0, finish.stderr);
  const finishPayload = JSON.parse(finish.stdout.trim());
  const cycleId = finishPayload.cycle_id;

  const gatePath = path.join(root, ".ato", "cycles", cycleId, "gate-full.json");
  const gatePayload = JSON.parse(await fs.readFile(gatePath, "utf8"));
  const runnerResult = gatePayload.results.find((result) => result.id === "runner");
  const runnerArtifacts = Array.isArray(runnerResult?.artifacts)
    ? runnerResult.artifacts
    : runnerResult?.artifact
      ? [runnerResult.artifact]
      : [];
  assert.ok(runnerArtifacts.length > 0, "runner gate artifact missing");

  const artifactPath = path.join(root, runnerArtifacts[0]);
  const artifact = await fs.readFile(artifactPath, "utf8");
  const header = parseRunnerHeader(artifact);

  return { header };
};

const assertTempBinding = ({ header }) => {
  assert.ok(header.temp_run_dir_sha256);
  assert.ok(header.temp_root_hash);
  if (header.temp_root) {
    assert.ok(!path.isAbsolute(header.temp_root));
    assert.ok(header.temp_root.startsWith(".ato/"));
  }
  if (header.temp_run_dir) {
    assert.ok(!path.isAbsolute(header.temp_run_dir));
    assert.ok(header.temp_run_dir.startsWith(".ato/"));
  }
};

const recordTempSourceEvidence = async ({ caseId, header }) => {
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
      "acceptance-temp-source-cases.json",
    );
    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    } catch {
      existing = [];
    }
    const entry = {
      case: caseId,
      temp_source: header.temp_source ?? null,
      temp_run_dir_sha256: header.temp_run_dir_sha256 ?? null,
    };
    const next = [
      ...existing.filter((item) => item?.case !== caseId),
      entry,
    ].sort((a, b) => String(a.case).localeCompare(String(b.case)));
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
  } catch {
    return;
  }
};

test("cycle finish uses gate temp policy when TMPDIR is unset", async () => {
  const { header } = await runCycleFinish();
  assert.equal(header.temp_source, "repo_default");
  assertTempBinding({ header });
  await recordTempSourceEvidence({ caseId: "unset", header });
});

test("cycle finish respects explicit TMPDIR", async () => {
  const customTmp = ".ato/tmp-custom";
  const { header } = await runCycleFinish({
    envOverrides: { TMPDIR: customTmp },
  });
  assert.equal(header.temp_source, "env:TMPDIR");
  assertTempBinding({ header });
  await recordTempSourceEvidence({ caseId: "set", header });
});
