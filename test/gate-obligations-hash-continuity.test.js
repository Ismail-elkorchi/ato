import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { computeGateObligations } from "../dist/core/blocks/seal.js";

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

const writeConfig = async (root, { gateCmd, gateId = "ok" }) => {
  const config = {
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
          root: [{ id: gateId, cmd: gateCmd }],
        },
      },
    },
  };
  await writeJson(path.join(root, ".ato", "config.json"), config);
  return config;
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
    frozen: true,
    cyclesPlanned: 2,
    baseline: { tag: baselineTag },
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

const writeQueue = async (root) => {
  const items = [
    {
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
    },
    {
      id: "BL-0002",
      title: "Block-0005 queued item two",
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
    },
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

test("cycle finish refuses when gate obligations drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-obligations-"));
  initGit(root);
  await writeAgents(root);
  await writeContracts(root);

  const baselineTag = "baseline-test";
  const config = await writeConfig(root, {
    gateCmd: [process.execPath, "-e", "process.exit(0)"],
  });
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);

  const obligations = await computeGateObligations({
    root,
    targetId: "tmp",
    config,
    blockId: "block-0005",
  });
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.seal.json"), {
    schema_version: "block-seal.v1",
    block_id: "block-0005",
    created_at: "2025-01-01T00:00:00.000Z",
    obligations_hash: obligations.obligations_hash,
    inputs: obligations.inputs,
  });

  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const start1 = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(start1.status, 0, start1.stderr);

  const finishArgs = [
    cliPath,
    "cycle",
    "finish",
    "--json",
    "--run-acceptance",
    "--run-gate",
    "--run-pack-verify"
  ];
  const finish1 = spawnSync(
    process.execPath,
    finishArgs,
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(finish1.status, 0, finish1.stderr);

  commitAll(root);

  const start2 = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(start2.status, 0, start2.stderr);

  await writeConfig(root, {
    gateCmd: [process.execPath, "-e", "process.exit(0)"],
    gateId: "ok2",
  });

  const finish2 = spawnSync(
    process.execPath,
    finishArgs,
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(finish2.status, 0);
  const payload = JSON.parse(finish2.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /block seal|obligations/i);
});
