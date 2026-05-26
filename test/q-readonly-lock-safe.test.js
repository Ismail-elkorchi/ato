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

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

test("q list and q view remain readable when ato lock is held by running pid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-q-read-lock-"));
  const storeDir = ".ato";

  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "q-read-lock-seed",
  });

  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  await writeJson(path.join(root, storeDir, "lock.json"), {
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  const list = runCli(root, ["q", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  const listPayload = JSON.parse(list.stdout.trim());
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.count, 0);

  const view = runCli(root, ["q", "view", "--json"]);
  assert.equal(view.status, 0, view.stderr);
  const viewPayload = JSON.parse(view.stdout.trim());
  assert.equal(viewPayload.ok, true);
  assert.equal(viewPayload.count, 0);
});
