import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildContractIndex } from "../dist/core/contracts/index.js";
import {
  INPUT_CITATION_HELP_PATTERN,
  INPUT_CITATION_PREFIX_MESSAGE,
  isInputCitation,
} from "../dist/core/queue/citations.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, values) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = values.map((value) => JSON.stringify(value));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
};

const writeContractIndex = async (root, storeDir, contractDoc) => {
  const docRel = path.relative(root, contractDoc).replace(/\\/g, "/");
  const index = await buildContractIndex([{ path: docRel, absPath: contractDoc }]);
  const cacheDir = path.join(root, storeDir, "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(
    path.join(cacheDir, "contracts.index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
};

test("shared input citation helper is strict and case-insensitive", () => {
  assert.equal(isInputCitation("file:docs/USER_GUIDE.md"), true);
  assert.equal(isInputCitation("FILE:docs/USER_GUIDE.md"), true);
  assert.equal(isInputCitation("cmd:npm run build"), true);
  assert.equal(isInputCitation("Log:test-artifact"), true);
  assert.equal(isInputCitation("note:manual"), false);
  assert.equal(isInputCitation("docs/USER_GUIDE.md"), false);
});

test("q update help and runtime honor shared citation grammar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-citation-prefix-"));
  const storeDir = ".ato";
  const contractDoc = path.join(root, storeDir, "contracts", "PLATFORM_CONTRACT.md");
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "citation-prefix-consistency-seed",
    contracts: { platform: contractDoc },
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  await fs.mkdir(path.dirname(contractDoc), { recursive: true });
  await fs.writeFile(contractDoc, "# PLATFORM\n\n## 1.1 Citation Rule\n", "utf8");
  await writeContractIndex(root, storeDir, contractDoc);
  await writeJsonl(path.join(root, storeDir, "queue", "items.jsonl"), [
    {
      id: "BL-0001",
      title: "Citation grammar parity",
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
      notes: "Summary. Evidence: output:seed",
      spec: {
        problem: "citation grammar drift",
        outcome: "shared grammar",
        plan: {
          steps: ["update queue item"],
          rationale: "Evidence: output:seed",
        },
        acceptance_criteria: ["cmd:ato q validate --json"],
        inputs: ["output:seed"],
        deliverables: ["parity guardrail"],
        scope: [],
        risks: [],
        contract_refs: [{ doc: contractDoc, section: "1.1" }],
        runbook: [],
      },
    },
  ]);

  const cliPath = path.resolve("dist/cli/main.js");
  const help = spawnSync(
    process.execPath,
    [cliPath, "q", "update", "--help"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.ok(
    help.stdout.includes(`--evidence-add <${INPUT_CITATION_HELP_PATTERN}>`),
    help.stdout,
  );

  const update = spawnSync(
    process.execPath,
    [cliPath, "q", "update", "BL-0001", "--evidence-add", "FILE:docs/USER_GUIDE.md", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    update.status,
    0,
    update.stderr || `Expected citation prefix list: ${INPUT_CITATION_PREFIX_MESSAGE}`,
  );

  const validate = spawnSync(
    process.execPath,
    [cliPath, "q", "validate", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(validate.status, 0, validate.stderr);
  const payload = JSON.parse(validate.stdout.trim());
  assert.equal(payload.ok, true);
});
