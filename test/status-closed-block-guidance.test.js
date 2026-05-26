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

const writeClosedBlock = async (root, blockId) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", `${blockId}.json`), {
    version: 1,
    blockId,
  });
  await writeJson(
    path.join(root, ".ato", "meta", "blocks", `${blockId}.closure.json`),
    {
      schema_version: "block-closure.v1",
      blockId,
      closed_at: "2025-01-01T00:00:00.000Z",
      report_ref: {
        path: `.ato/closeout/${blockId}.report.json`,
        sha256: "sha256:placeholder",
      },
    },
  );
};

test("status guides opening the next block when the latest block is closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-closed-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeClosedBlock(root, "block-0006");
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "status.v2");
  assert.equal(payload.active_block_id, null);
  assert.equal(payload.next_block_id, "block-0007");
  assert.equal(payload.selected_queue_id, null);
  assert.equal(payload.next_action, "Open next block block-0007.");
  assert.equal(payload.next_action_state, "missing_active_block");
  assert.equal(payload.next_action_reason, "no_active_block_open_next_block");
  assert.equal(payload.next_action_source, "status-transition-registry.v1");
  assert.ok(!payload.next_action.includes("Create a queued/active block-scoped"));
  assert.deepEqual(payload.agent_instructions, ["Open next block block-0007."]);
});

test("status advances to block-0009 when block-0008 is closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-closed-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeClosedBlock(root, "block-0008");
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "status.v2");
  assert.ok(payload.active_block_id === null || payload.active_block_id !== "block-0008");
  assert.equal(payload.next_block_id, "block-0009");
  assert.equal(payload.selected_queue_id, null);
  assert.equal(payload.next_action, "Open next block block-0009.");
  assert.equal(payload.next_action_state, "missing_active_block");
  assert.equal(payload.next_action_reason, "no_active_block_open_next_block");
  assert.equal(payload.next_action_source, "status-transition-registry.v1");
  assert.ok(!payload.next_action.includes("Create a queued/active block-scoped"));
});
