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

const setupGateRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-progress-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "progress-seed",
    gates: {
      fast: [
        {
          id: "touch",
          cmd: ["node", "-e", "require('fs').writeFileSync('touched.txt','ok')"],
        },
      ],
    },
  };

  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
  const gitInit = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  return root;
};

test("gate run prints step start/end markers", async () => {
  const root = await setupGateRoot();
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "fast"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("[gate] start touch"));
  assert.ok(result.stdout.includes("[gate] end touch (ok)"));
});

test("gate json reports started_at and ended_at", async () => {
  const root = await setupGateRoot();
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "fast", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  const step = payload.results[0];
  assert.ok(typeof step.started_at === "string" && step.started_at.length > 0);
  assert.ok(typeof step.ended_at === "string" && step.ended_at.length > 0);
});

test("gate heartbeat emits deterministic ticks when enabled", async () => {
  const root = await setupGateRoot();
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "fast", "--heartbeat", "1"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ATO_GATE_HEARTBEAT_TICKS: "2",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const matches = result.stdout.match(/\[gate\] heartbeat touch/g) ?? [];
  assert.equal(matches.length, 2);
});
