import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildContractIndex } from "../dist/core/contracts/index.js";

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

const writeConfig = async (root, contractDoc) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
    contracts: { platform: contractDoc },
  });
};

const writeContracts = async (root) => {
  const contractDoc = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 0 Purpose\n", "utf8");

  const docRel = path.relative(root, contractDoc).replace(/\\/g, "/");
  const index = await buildContractIndex([{ path: docRel, absPath: contractDoc }]);
  await fs.mkdir(path.join(root, ".ato", "cache"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".ato", "cache", "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );

  return contractDoc;
};

const writeQueue = async (root) => {
  const item = {
    id: "BL-0001",
    title: "Queued item",
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
      inputs: ["file:seed"],
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

const runCli = (cwd, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
};

test("default repo resolution works from subdirectories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-repo-default-"));
  initGit(root);
  await writeAgents(root);
  const contractDoc = await writeContracts(root);
  await writeConfig(root, contractDoc);
  await writeQueue(root);
  commitAll(root);

  const subdir = path.join(root, "nested", "dir");
  await fs.mkdir(subdir, { recursive: true });

  const status = runCli(subdir, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout.trim());
  assert.equal(statusPayload.ok, true);

  const start = runCli(subdir, ["cycle", "start", "--json"]);
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  assert.equal(startPayload.ok, true);
  assert.equal(startPayload.queue_id, "BL-0001");
});
