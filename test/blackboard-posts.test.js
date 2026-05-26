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
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "bb-post-seed",
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

test("bb post stores untrusted posts and bb show includes them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-post-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const post = runCli(root, [
    "bb",
    "post",
    "--kind",
    "note",
    "--text",
    "hello",
    "--block-id",
    "block-0008",
    "--author",
    "tester",
    "--json",
  ]);
  assert.equal(post.status, 0, post.stderr);
  const postPayload = JSON.parse(post.stdout);
  assert.equal(postPayload.schema_version, "bb-post.v1");
  assert.ok(postPayload.post_id);
  assert.ok(postPayload.sha256);
  assert.equal(postPayload.post.kind, "note");
  assert.equal(postPayload.post.trust, "untrusted");
  assert.equal(postPayload.post.scope.block_id, "block-0008");
  assert.equal(postPayload.post.author, "tester");
  assert.equal(postPayload.post.text, undefined);

  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  const inboxFiles = await fs.readdir(inboxDir);
  assert.ok(inboxFiles.some((name) => name.includes(postPayload.post_id)));

  const show = runCli(root, ["bb", "show", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  const payload = JSON.parse(show.stdout);
  const posts = payload.posts ?? [];
  assert.ok(posts.some((entry) => entry.text === "hello"));
});
