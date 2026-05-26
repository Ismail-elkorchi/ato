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
  await fs.mkdir(path.join(root, ".ato", "contracts"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md"),
    "# Platform Contract\n\n## §0\nBaseline contract section.\n",
    "utf8",
  );
};

const writeBlock = async (root, { baselineTag }) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), {
    version: 1,
    blockId: "block-0005",
    frozen: true,
    baseline: { tag: baselineTag },
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
    notes: "Evidence: output:seed",
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

const tagBaseline = (root, tag) => {
  const result = spawnSync("git", ["tag", tag], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

test("cycle start refuses when prior gate artifacts are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-prior-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  const baselineTag = "baseline-test";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);

  const priorRecord = {
    schema_version: "cycle-record.v1",
    id: "CY-0001",
    ts: "2025-01-01T00:00:00.000Z",
    block_id: "block-0005",
    cycle_index: 1,
    hypothesis: "prior cycle",
    acceptance_checks: ["cmd:echo ok"],
    evidence: ["file:.ato/cycles/CY-0001/preflight.json"],
    outcome: "ok",
    selection_evidence: {
      mode: "queue",
      cycle_id: "CY-0001",
      cycle_index: 1,
      scope: "block",
      seed: { source: "blockId", value: "block-0005", block_id: "block-0005" },
      candidates: { total: 1, eligible: 1 },
      excluded_by_reason: {
        out_of_scope: 0,
        status: 0,
        deps: 0,
        missing_evidence: 0,
      },
      selection: { queue_id: "BL-0001", hash: crypto.createHash("sha256").update("x").digest("hex") },
    },
    gate_evidence: {
      mode: "full",
      result: { ok: true },
      obligations_hash: crypto.createHash("sha256").update("gate").digest("hex"),
      artifacts: [
        {
          path: ".ato/runs/artifacts/global/gate/missing.log",
          sha256: crypto.createHash("sha256").update("missing").digest("hex"),
        },
      ],
    },
    preflight_evidence: {
      path: ".ato/cycles/CY-0001/preflight.json",
      sha256: crypto.createHash("sha256").update("preflight").digest("hex"),
    },
    checks: [],
  };
  await writeJsonl(path.join(root, ".ato", "cycles", "ledger.jsonl"), [priorRecord]);

  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /prior gate artifacts/i);
});
