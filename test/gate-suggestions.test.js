import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildContractIndex } from "../dist/core/contracts/index.js";

const sanitizeEnv = (env) => {
  const next = { ...env };
  const stripKeys = new Set(["ATO_TEST_SHARD"]);
  for (const key of Object.keys(next)) {
    if (key.startsWith("NODE_TEST") || stripKeys.has(key)) {
      delete next[key];
    }
  }
  return next;
};

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

const writeContractIndex = async (root, storeDir, contractDoc) => {
  const docRel = path.relative(root, contractDoc).replace(/\\/g, "/");
  const index = await buildContractIndex([{ path: docRel, absPath: contractDoc }]);
  await fs.mkdir(path.join(root, storeDir, "cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "cache", "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
};

const writeConfig = async (root, contractDoc) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "test-seed",
    contracts: { platform: contractDoc },
    gates: {
      full: {
        tests: {
          order: ["root"],
          root: [
            {
              id: "fail",
              cmd: [process.execPath, "-e", "process.exit(1)"],
            },
          ],
        },
      },
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

const writeQueue = async (root) => {
  const item = {
    id: "BL-0001",
    title: "Block-0005 gate suggestion test",
    type: "bug",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "Completed. Evidence: output:seed",
    spec: {
      problem: "Gate failures lack suggestions on first run.",
      outcome: "Suggestions are always emitted.",
      plan: {
        steps: ["Trigger gate failure", "Check suggestions"],
      },
      acceptance_criteria: ["cmd:ato cycle finish --json"],
      inputs: ["output:seed"],
      deliverables: ["Suggestions in error details."],
      scope: [],
      risks: [],
      contract_refs: ["6.2 Ticket minimum fields"],
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

test("gate failure emits suggestions on first failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  initGit(root);
  await writeAgents(root);
  await writeConfig(root, contractDoc);
  await writeContractIndex(root, storeDir, contractDoc);

  const baselineTag = "baseline-gate-suggest";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env: sanitizeEnv(process.env) },
  );
  assert.equal(start.status, 0, start.stderr);

  const finish = spawnSync(
    process.execPath,
    [cliPath, "cycle", "finish", "--json", "--run-gate"],
    { cwd: root, encoding: "utf8", env: sanitizeEnv(process.env) },
  );
  assert.equal(finish.status, 4, finish.stderr);
  const payload = JSON.parse(finish.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error?.details);
  assert.ok(payload.error.details.suggestions);
  assert.ok(Array.isArray(payload.error.details.suggested_fix));
  assert.ok(payload.error.details.suggested_fix.length > 0);
  assert.ok(Array.isArray(payload.error.details.next_actions));
  assert.ok(payload.error.details.next_actions.length > 0);
  assert.deepEqual(payload.error.details.suggested_fix, payload.error.details.next_actions);

  const suggestionsPath = path.join(
    root,
    storeDir,
    "memory",
    "learning",
    "suggestions.jsonl",
  );
  const suggestionsRaw = await fs.readFile(suggestionsPath, "utf8");
  assert.ok(suggestionsRaw.trim().length > 0);
});
