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

const setupRepo = async ({ root, contractDoc, items }) => {
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: `queue-origin-${path.basename(root)}`,
    contracts: { platform: contractDoc },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(root, storeDir, contractDoc);
  const queueDir = path.join(root, storeDir, "queue");
  await fs.mkdir(queueDir, { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(
    path.join(queueDir, "items.jsonl"),
    output.length ? `${output}\n` : "",
    "utf8",
  );
};

const initGitRepo = async (root) => {
  const run = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "origin test\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["remote", "add", "origin", "https://example.com/source.git"]);
  const head = run(["rev-parse", "HEAD"]);
  return String(head.stdout).trim();
};

const readQueueItems = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

test("q transfer preserves or populates origin metadata", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-origin-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-origin-dest-"));
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");

  const head = await initGitRepo(sourceRoot);

  const sourceItem = {
    id: "BL-0001",
    title: "Source item",
    type: "feature",
    status: "queued",
    priority: "P1",
    tags: ["origin"],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.2.x" },
    deps: [],
    evidence: ["file:seed.txt"],
    owner: "agent",
    notes: "source notes",
    spec: {
      problem: "Source queue item needs transfer.",
      outcome: "Transfer copies item into destination.",
      plan: {
        steps: ["Transfer item", "Verify origin"],
      },
      acceptance_criteria: ["cmd:node dist/cli/main.js q transfer"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  const originPreserved = {
    repo_remote: "https://example.com/origin.git",
    commit: "deadbeef",
    subpath: "src",
    created_by: "human",
  };

  const sourceItemWithOrigin = {
    ...sourceItem,
    id: "BL-0002",
    title: "Source item with origin",
    origin: originPreserved,
  };

  const destItem = {
    id: "BL-0001",
    title: "Destination seed",
    type: "feature",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "range:0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    spec: {
      problem: "Seed dest.",
      outcome: "Queue exists.",
      plan: {
        steps: ["Seed destination queue"],
      },
      acceptance_criteria: ["cmd:seed"],
      inputs: ["file:seed.txt"],
      deliverables: ["src/cli/commands/q.ts"],
      scope: ["src/cli/commands/q.ts"],
      risks: [],
      contract_refs: ["6.2"],
      runbook: [],
    },
  };

  await setupRepo({
    root: sourceRoot,
    contractDoc,
    items: [sourceItem, sourceItemWithOrigin],
  });
  await setupRepo({ root: destRoot, contractDoc, items: [destItem] });
  await writeJson(path.join(sourceRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: destRoot, id: "tmp" }],
  });
  await writeJson(path.join(destRoot, ".ato", "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "tmp" }],
  });

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "transfer",
      "--all",
      "--dest",
      destRoot,
      "--allow-cross-store-write",
      "--source",
      sourceRoot,
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  const mapping = payload.mapping;

  const itemsPath = path.join(destRoot, ".ato", "queue", "items.jsonl");
  const items = await readQueueItems(itemsPath);

  const transferred = items.find((entry) => entry.id === mapping["BL-0001"]);
  assert.ok(transferred);
  assert.ok(transferred.origin);
  assert.equal(transferred.origin.commit, head);
  assert.equal(transferred.origin.repo_remote, "https://example.com/source.git");
  assert.equal(transferred.origin.repo_path ?? null, null);
  assert.equal(transferred.origin.subpath ?? null, null);

  const preserved = items.find((entry) => entry.id === mapping["BL-0002"]);
  assert.ok(preserved);
  assert.deepEqual(preserved.origin, originPreserved);
});
