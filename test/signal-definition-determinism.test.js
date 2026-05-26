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

const writeAgents = async (root) => {
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
};

const writeConfig = async (root, storeDir) => {
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
};

const runCommand = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

const validCatalog = [
  {
    name: "zeta_signal",
    type: "cost",
    source: "source z",
    collection_method: "manual",
    evidence_format: "evidence z",
    action_rule: "none",
  },
  {
    name: "alpha_signal",
    type: "reliability",
    source: "source a",
    collection_method: "manual",
    evidence_format: "evidence a",
    action_rule: "none",
  },
];

const invalidCatalog = [
  {
    name: "",
    type: "unknown",
    source: "",
    collection_method: "",
    evidence_format: "",
    action_rule: "",
  },
  {
    type: "cost",
    source: "only",
  },
];

const assertStableJson = (first, second) => {
  assert.equal(second.stdout, first.stdout);
  const parsed = JSON.parse(first.stdout.trim());
  return parsed;
};

test("signal definition list is deterministic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-signal-list-"));
  const storeDir = ".ato";
  await writeConfig(root, storeDir);
  await writeAgents(root);
  await writeJson(
    path.join(root, storeDir, "signals", "definitions.json"),
    validCatalog,
  );

  const first = runCommand(root, ["signal", "definition", "list", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runCommand(root, ["signal", "definition", "list", "--json"]);
  assert.equal(second.status, 0, second.stderr);

  const payload = assertStableJson(first, second);
  const names = payload.signals.map((signal) => signal.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});

test("signal definition validate errors are deterministic and sorted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-signal-validate-"));
  const storeDir = ".ato";
  await writeConfig(root, storeDir);
  await writeAgents(root);
  await writeJson(
    path.join(root, storeDir, "signals", "definitions.json"),
    invalidCatalog,
  );

  const first = runCommand(root, [
    "signal",
    "definition",
    "validate",
    "--json",
  ]);
  assert.equal(first.status, 3, first.stderr);
  const second = runCommand(root, [
    "signal",
    "definition",
    "validate",
    "--json",
  ]);
  assert.equal(second.status, 3, second.stderr);

  const payload = assertStableJson(first, second);
  assert.ok(payload.errors.length > 1);
  const sorted = [...payload.errors].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(payload.errors, sorted);
});
