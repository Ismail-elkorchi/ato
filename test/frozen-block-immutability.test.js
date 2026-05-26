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

const writeConfig = async (root) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
  });
};

const writeBlock = async (root) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), {
    version: 1,
    blockId: "block-0005",
    frozen: true,
    baseline: { tag: "baseline-test" },
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

test("protocol check and cycle start refuse frozen block edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-frozen-block-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeBlock(root);
  commitAll(root);

  const blockPath = path.join(root, ".ato", "meta", "blocks", "block-0005.json");
  await fs.appendFile(blockPath, "\n");

  const cliPath = path.resolve("dist/cli/main.js");
  const protocolCheck = spawnSync(
    process.execPath,
    [cliPath, "protocol", "check", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(protocolCheck.status, 0);
  const protocolPayload = JSON.parse(protocolCheck.stdout.trim());
  assert.equal(protocolPayload.ok, false);
  assert.ok(
    protocolPayload.errors.some((entry) => entry.kind === "protected_block_modified"),
  );

  const cycleStart = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(cycleStart.status, 0);
  const cyclePayload = JSON.parse(cycleStart.stdout.trim());
  assert.equal(cyclePayload.ok, false);
  const details = cyclePayload.error?.details;
  assert.ok(details?.errors?.some((entry) => entry.kind === "protected_block_modified"));
});
