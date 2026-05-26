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

test("q trace prints a compact human view", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-trace-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "q-trace-seed-human",
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);

  const origin = {
    repo_remote: "https://example.com/ato.git",
    repo_path: "/tmp/source-repo",
    commit: "abc1234",
    subpath: "packages/app",
  };
  const item = {
    id: "BL-0001",
    title: "Trace output",
    type: "feature",
    status: "queued",
    priority: "P1",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.2.x" },
    deps: [],
    evidence: ["file:seed.txt"],
    owner: "agent",
    notes: "",
    origin,
    spec: {
      problem: "Trace output is missing.",
      outcome: "Trace output includes origin.",
      plan: {
        steps: ["Run q trace", "Inspect output"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q trace"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  await fs.mkdir(path.join(root, storeDir, "queue"), { recursive: true });
  await fs.writeFile(
    path.join(root, storeDir, "queue", "items.jsonl"),
    `${JSON.stringify(item)}\n`,
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "q", "trace", "BL-0001"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("trace: BL-0001"));
  assert.ok(result.stdout.includes("title: Trace output"));
  assert.ok(result.stdout.includes("status: queued"));
  assert.ok(result.stdout.includes("priority: P1"));
  assert.ok(result.stdout.includes("origin:"));
  assert.ok(result.stdout.includes(`repo_remote: ${origin.repo_remote}`));
  assert.ok(result.stdout.includes(`repo_path: ${origin.repo_path}`));
  assert.ok(result.stdout.includes(`commit: ${origin.commit}`));
  assert.ok(result.stdout.includes(`subpath: ${origin.subpath}`));
  assert.ok(
    result.stdout.includes(`ATO_REPO="${origin.repo_path}"`),
  );
  assert.ok(result.stdout.includes(`git show ${origin.commit}`));
  assert.ok(result.stdout.includes(`git checkout ${origin.commit}`));
});
