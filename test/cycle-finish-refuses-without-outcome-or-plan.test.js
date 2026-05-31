import { test } from "node:test";
import assert from "node:assert/strict";
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
  await fs.writeFile(docPath, "# 1 Bootstrap\n", "utf8");
};

const writeQueue = async (root) => {
  const item = {
    id: "BL-0001",
    title: "Bootstrap cycle item",
    type: "tooling",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "milestone", value: "bootstrap" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "Summary. Evidence: output:seed",
    spec: {
      problem: "Cycle finish should not require intent commands.",
      outcome: "Cycle finish completes without outcome/plan entries.",
      plan: {
        steps: ["Run cycle finish"],
      },
      acceptance_criteria: [
        "cmd:node -e process.exit(0)",
        "cmd:ato cycle finish --json",
      ],
      inputs: ["output:seed"],
      deliverables: ["deliverable"],
      scope: ["bootstrap"],
      risks: [],
      contract_refs: ["1"],
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

test("cycle finish does not require outcome or plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-finish-intent-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  await writeQueue(root);
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env };
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
  assert.equal(finish.status, 0, finish.stdout.trim() || finish.stderr);
  const payload = JSON.parse(finish.stdout.trim());
  assert.equal(payload.ok, true);
});
