import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
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
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "bb-mailbox-seed",
    contracts: {
      platform: path.resolve(".ato/contracts/PLATFORM_CONTRACT.md"),
    },
    blackboard: {
      observations: [],
    },
  };
  await writeJson(path.join(root, ".ato", "config.json"), config);
};

const writeCatalog = async (root) => {
  await writeJson(path.join(root, ".ato", "signals", "definitions.json"), [
    {
      name: "agent_total_tokens",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "telemetry_missing",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
  ]);
};

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

const hashFile = async (filePath) => {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
};

test("bb snapshot is removed and does not write files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-snapshot-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const result = runCli(root, ["bb", "snapshot", "--json"]);
  assert.notEqual(result.status, 0);

  const blackboardDir = path.join(root, ".ato", "blackboard");
  await assert.rejects(fs.stat(blackboardDir));
});

test("bb note add is removed and does not write files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-note-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const result = runCli(root, ["bb", "note", "add", "--text", "hi", "--json"]);
  assert.notEqual(result.status, 0);

  const blackboardDir = path.join(root, ".ato", "blackboard");
  await assert.rejects(fs.stat(blackboardDir));
});

test("bb post succeeds even when a lock file exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-lock-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);
  await writeJson(path.join(root, ".ato", "lock.json"), {
    pid: 123,
    startedAt: "2025-01-01T00:00:00.000Z",
  });

  const result = runCli(root, [
    "bb",
    "post",
    "--kind",
    "note",
    "--text",
    "lock ok",
    "--block-id",
    "block-0008",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  const entries = await fs.readdir(inboxDir);
  assert.ok(entries.some((name) => name.includes(payload.post_id)));
});

test("bb show orders posts deterministically and is read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-show-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  await fs.mkdir(inboxDir, { recursive: true });
  const postA = {
    schema_version: "bb-post.v1",
    id: "20240102T000000000Z__b",
    created_at: "2024-01-02T00:00:00.000Z",
    kind: "note",
    author: "tester",
    scope: { block_id: "block-0008" },
    text: "later",
    trust: "untrusted",
  };
  const postB = {
    schema_version: "bb-post.v1",
    id: "20240101T000000000Z__a",
    created_at: "2024-01-01T00:00:00.000Z",
    kind: "note",
    author: "tester",
    scope: { block_id: "block-0008" },
    text: "earlier",
    trust: "untrusted",
  };
  await fs.writeFile(
    path.join(inboxDir, `${postA.id}.json`),
    `${JSON.stringify(postA)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(inboxDir, `${postB.id}.json`),
    `${JSON.stringify(postB)}\n`,
    "utf8",
  );

  const queuePath = path.join(root, ".ato", "queue", "items.jsonl");
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, "{\"id\":\"BL-0001\"}\n", "utf8");
  const before = await hashFile(queuePath);

  const first = runCli(root, ["bb", "show", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(root, ["bb", "show", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);

  const payload = JSON.parse(first.stdout);
  const postIds = (payload.posts ?? []).map((post) => post.id);
  assert.deepEqual(postIds, [postB.id, postA.id]);

  const after = await hashFile(queuePath);
  assert.equal(after, before);
});
