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

test("contract-refs fix apply rewrites refs and preserves originals", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-contract-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-contract-dest-"));
  const storeDir = ".ato";

  const sourceContractDoc = path.join(sourceRoot, "SOURCE_CONTRACT.md");
  const destContractDoc = path.join(destRoot, "DEST_CONTRACT.md");

  await fs.writeFile(
    sourceContractDoc,
    "# Source Contract\n\n## 1.0 Source Section\n\n## 6.4 External intake: minimum compliance\n",
    "utf8",
  );
  await fs.writeFile(
    destContractDoc,
    "# Dest Contract\n\n## 6.4 External intake: minimum compliance\n",
    "utf8",
  );

  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "contract-src",
    contracts: { platform: "SOURCE_CONTRACT.md" },
  });
  await fs.writeFile(
    path.join(sourceRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(sourceRoot, storeDir, sourceContractDoc);

  await writeJson(path.join(destRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "dest",
    storeDir,
    fingerprintSeed: "contract-dest",
    contracts: { platform: "DEST_CONTRACT.md" },
  });
  await fs.writeFile(
    path.join(destRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await writeContractIndex(destRoot, storeDir, destContractDoc);

  await fs.mkdir(path.join(sourceRoot, storeDir, "queue"), { recursive: true });
  const item = {
    id: "BL-0001",
    title: "Source item",
    type: "feature",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    target: { selector: "range", value: "range:0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "",
    origin: {
      repo_path: sourceRoot,
      commit: "deadbeef",
    },
    spec: {
      problem: "p",
      outcome: "o",
      plan: {
        steps: ["Fix contract refs"],
      },
      acceptance_criteria: ["cmd:ok"],
      inputs: ["file:input"],
      deliverables: ["deliverable"],
      scope: ["src/**"],
      risks: [],
      contract_refs: ["1.0"],
      runbook: [],
    },
  };
  const itemsPath = path.join(sourceRoot, storeDir, "queue", "items.jsonl");
  await fs.writeFile(itemsPath, `${JSON.stringify(item)}\n`, "utf8");

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "q",
      "contract-refs",
      "fix",
      "--ids",
      "BL-0001",
      "--dest",
      destRoot,
      "--apply",
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.apply, true);

  const updatedRaw = await fs.readFile(itemsPath, "utf8");
  const updated = JSON.parse(updatedRaw.trim());
  assert.deepEqual(updated.spec.contract_refs, ["6.4"]);
  assert.deepEqual(updated.origin.contract_refs, ["1.0"]);
});
