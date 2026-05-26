import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { buildSelectionFailureGuidance } from "../dist/core/state/transitions.js";

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
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0006.json"), {
    version: 1,
    blockId: "block-0006",
    baseline: { tag: baselineTag },
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles: 5,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
    },
  });
};

const makeQueueItem = ({ id, title }) => ({
  id,
  title,
  type: "tooling",
  status: "done",
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
    plan: { steps: ["step"] },
    acceptance_criteria: ["cmd:echo ok"],
    inputs: [],
    deliverables: ["deliverable"],
    scope: [],
    risks: [],
    contract_refs: ["§5"],
    runbook: [],
  },
});

const writeQueue = async (root) => {
  const items = [
    makeQueueItem({ id: "BL-0001", title: "Block-0006 done item 1" }),
    makeQueueItem({ id: "BL-0002", title: "Block-0006 done item 2" }),
    makeQueueItem({ id: "BL-0003", title: "Block-0006 done item 3" }),
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

test("status and cycle-start use the same selection-failure guidance text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-selection-guidance-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  const baselineTag = "baseline-guidance";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const expected = buildSelectionFailureGuidance("block-0006");
  const cliPath = path.resolve("dist/cli/main.js");

  const status = spawnSync(
    process.execPath,
    [cliPath, "status", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout.trim());
  assert.equal(statusPayload.next_action, expected);
  assert.equal(statusPayload.agent_instructions?.[0], expected);

  const cycleStart = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cycleStart.status, 3, cycleStart.stderr);
  const cyclePayload = JSON.parse(cycleStart.stdout.trim());
  assert.equal(cyclePayload.suggested_fix?.[0], expected);
});
