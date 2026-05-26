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

test("session closeout apply does not write to target when validation fails", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-src-"));
  const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-closeout-dest-"));
  const storeDir = ".ato";
  const contractDoc = path.resolve(".ato/contracts/PLATFORM_CONTRACT.md");
  const destContractDoc = path.join(destRoot, "DEST_CONTRACT.md");
  const sourceContractDoc = path.join(
    sourceRoot,
    storeDir,
    "contracts",
    "PLATFORM_CONTRACT.md",
  );

  await writeJson(path.join(sourceRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "src",
    storeDir,
    fingerprintSeed: "closeout-src",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  });
  await fs.writeFile(
    path.join(sourceRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.writeFile(path.join(sourceRoot, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["init"], { cwd: sourceRoot, encoding: "utf8" });
  spawnSync("git", ["add", "README.md"], { cwd: sourceRoot, encoding: "utf8" });
  spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "seed"],
    { cwd: sourceRoot, encoding: "utf8" },
  );
  await fs.mkdir(path.dirname(sourceContractDoc), { recursive: true });
  await fs.copyFile(contractDoc, sourceContractDoc);
  await writeContractIndex(sourceRoot, storeDir, sourceContractDoc);

  await fs.writeFile(
    destContractDoc,
    "# Dest Contract\n\n## 1.0 Dest Seed\n",
    "utf8",
  );
  await writeJson(path.join(destRoot, storeDir, "config.json"), {
    version: 1,
    targetId: "dest",
    storeDir,
    fingerprintSeed: "closeout-dest",
    contracts: { platform: destContractDoc },
  });
  await fs.writeFile(
    path.join(destRoot, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.join(destRoot, storeDir, "queue"), { recursive: true });
  await fs.writeFile(
    path.join(destRoot, storeDir, "queue", "items.jsonl"),
    `${JSON.stringify({
      id: "BL-0001",
      title: "Dest seed",
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
        contract_refs: ["1.0"],
        runbook: [],
      },
    })}\n`,
    "utf8",
  );
  await writeContractIndex(destRoot, storeDir, destContractDoc);
  await writeJson(path.join(sourceRoot, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root: destRoot, id: "dest" }],
  });
  await writeJson(path.join(destRoot, storeDir, "cross-store.json"), {
    version: 1,
    allowlist: [{ root: sourceRoot, id: "src" }],
  });

  const gateRunPath = path.join(sourceRoot, ".ato", "runs", "last-gate.json");
  await writeJson(gateRunPath, {
    ok: false,
    results: [
      { id: "lint", ok: false, status: "fail", command: "npm run lint" },
    ],
  });

  const destItemsPath = path.join(destRoot, storeDir, "queue", "items.jsonl");
  const before = await fs.readFile(destItemsPath, "utf8");

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "session",
      "closeout",
      "apply",
      "--gate-run",
      gateRunPath,
      "--dest",
      destRoot,
      "--allow-cross-store-write",
      "--json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.result?.blocked_items?.length > 0);
  const blocked = payload.result.blocked_items[0];
  assert.equal(blocked.id, "BL-0001");
  assert.ok(blocked.fields.includes("spec.contract_refs"));
  assert.ok(blocked.guidance.some((entry) => entry.includes("contract index")));

  const after = await fs.readFile(destItemsPath, "utf8");
  assert.equal(after, before);
});
