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
          root: [
            { id: "ok", cmd: [process.execPath, "-e", "process.exit(0)"] },
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
    cyclesPlanned: 1,
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles: 5,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
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

const tagBaseline = (root, tag) => {
  const result = spawnSync("git", ["tag", tag], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
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
      acceptance_criteria: [
        "cmd:node -e process.exit(0)",
        "cmd:ato gate run --mode full --json",
        "cmd:ato cycle finish --json",
      ],
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

const writeQueueMissingCycleFinish = async (root) => {
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
      acceptance_criteria: ["cmd:node -e process.exit(0)"],
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

test("cycle finish refuses without active cycle", async () => {
  const root = await makeTempDir("ato-cycle-finish-");
  await writeAgents(root);
  await writeConfig(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "cycle", "finish", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /active cycle/i);
});

test("cycle finish writes relative evidence paths", async () => {
  const root = await makeTempDir("ato-cycle-finish-rel-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-test";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };
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

  const ledgerPath = path.join(root, ".ato", "eval", "ledger.jsonl");
  const ledgerRaw = await fs.readFile(ledgerPath, "utf8");
  const lines = ledgerRaw.trim().split(/\r?\n/);
  const last = JSON.parse(lines[lines.length - 1]);

  const serialized = JSON.stringify(last);
  assert.ok(!serialized.includes(root));

  const evidence = last.evidence ?? [];
  assert.ok(evidence.every((entry) => !String(entry).startsWith("/")));

  const artifacts = last.gate_evidence?.artifacts ?? [];
  assert.ok(artifacts.every((artifact) => !String(artifact.path).startsWith("/")));
  assert.ok(String(last.preflight_evidence.path || "").startsWith(".ato/"));
});

test("cycle finish succeeds after closing the active block", async () => {
  const root = await makeTempDir("ato-cycle-finish-close-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-close";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };
  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);

  const status = spawnSync(
    process.execPath,
    [cliPath, "status", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout.trim());
  const activeBlockId =
    typeof statusPayload.active_block_id === "string" &&
    statusPayload.active_block_id
      ? statusPayload.active_block_id
      : typeof statusPayload.active_cycle?.block_id === "string"
        ? statusPayload.active_cycle.block_id
        : "";
  assert.ok(activeBlockId, "missing active block id in status payload");

  const closeResult = spawnSync(
    process.execPath,
    [cliPath, "block", "close", "--block-id", activeBlockId, "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  const blocksDir = path.join(root, ".ato", "meta", "blocks");
  let blocksListing = "";
  try {
    const entries = await fs.readdir(blocksDir, { withFileTypes: true });
    blocksListing = entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("block-"))
      .sort()
      .join("\n");
  } catch (err) {
    blocksListing = `error reading blocks dir: ${String(err)}`;
  }
  if (closeResult.status !== 0) {
    const closeOut = closeResult.stdout.trim().split(/\r?\n/).slice(0, 200).join("\n");
    const closeErr = closeResult.stderr.trim().split(/\r?\n/).slice(0, 200).join("\n");
    assert.equal(
      closeResult.status,
      0,
      [
        "block close failed",
        `activeBlockId=${activeBlockId}`,
        "stdout:",
        closeOut,
        "stderr:",
        closeErr,
        "blocks:",
        blocksListing,
      ].join("\n"),
    );
  }

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
  if (finish.status !== 0) {
    const finishOut = finish.stdout.trim().split(/\r?\n/).slice(0, 200).join("\n");
    const finishErr = finish.stderr.trim().split(/\r?\n/).slice(0, 200).join("\n");
    let errorDetails = "";
    try {
      const payload = JSON.parse(finish.stdout.trim());
      const errors = payload?.error?.details?.errors ?? payload?.errors;
      errorDetails = JSON.stringify(
        {
          message: payload?.error?.message ?? payload?.message,
          errors,
        },
        null,
        2,
      );
    } catch {
      errorDetails = "";
    }
    assert.equal(
      finish.status,
      0,
      [
        "cycle finish failed",
        `activeBlockId=${activeBlockId}`,
        "close stdout:",
        closeResult.stdout.trim().split(/\r?\n/).slice(0, 200).join("\n"),
        "close stderr:",
        closeResult.stderr.trim().split(/\r?\n/).slice(0, 200).join("\n"),
        "finish stdout:",
        finishOut,
        "finish stderr:",
        finishErr,
        errorDetails ? `error details:\n${errorDetails}` : "error details: <none>",
        "blocks:",
        blocksListing,
      ].join("\n"),
    );
  }
  assert.equal(finish.status, 0, finish.stderr);
});

test("cycle finish failure leaves queue item unchanged", async () => {
  const root = await makeTempDir("ato-cycle-finish-queue-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-queue-fail";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueueMissingCycleFinish(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };
  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);

  const queuePath = path.join(root, ".ato", "queue", "items.jsonl");
  const beforeRaw = await fs.readFile(queuePath, "utf8");
  const beforeHash = crypto.createHash("sha256").update(beforeRaw).digest("hex");

  const finish = spawnSync(
    process.execPath,
    [cliPath, "cycle", "finish", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.notEqual(finish.status, 0);
  const payload = JSON.parse(finish.stdout.trim());
  assert.equal(payload.ok, false);
  const errorMessage = payload.error?.message ?? "";
  assert.ok(
    /invalid eval cycle/i.test(errorMessage) ||
      /requires explicit --run-acceptance/i.test(errorMessage),
  );

  const afterRaw = await fs.readFile(queuePath, "utf8");
  const afterHash = crypto.createHash("sha256").update(afterRaw).digest("hex");
  assert.equal(afterHash, beforeHash);
  const item = afterRaw
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.id === "BL-0001");
  assert.equal(item.status, "active");
  assert.equal(item.frozen, undefined);

  const validate = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(validate.status, 0, validate.stderr);
  const validatePayload = JSON.parse(validate.stdout.trim());
  assert.equal(validatePayload.ok, true);
});
