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
    fingerprintSeed: "bb-working-seed",
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
  await writeJson(path.join(root, ".ato", "signals", "definitions.json"), []);
};

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

test("working memory stays derived and non-authoritative", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-working-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const snapshot = runCli(root, [
    "memory",
    "snapshot",
    "--type",
    "working",
    "--summary",
    "Focus on queue BL-0007",
    "--json",
  ]);
  assert.equal(snapshot.status, 0, snapshot.stderr);

  const show = runCli(root, ["bb", "show", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  const payload = JSON.parse(show.stdout);
  const working = payload.working_memory;
  assert.ok(working, "working_memory missing");
  assert.deepEqual(
    Object.keys(working).sort(),
    ["created_at", "id", "source_path", "summary", "truncated"].sort(),
  );
  assert.ok(working.summary.includes("BL-0007"));
  assert.equal(Object.prototype.hasOwnProperty.call(working, "spec"), false);
});
