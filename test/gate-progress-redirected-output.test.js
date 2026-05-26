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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-redirect-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "redirect-seed",
    gates: {
      fast: [
        {
          id: "stderr-step",
          cmd: [
            "node",
            "-e",
            "console.log('OUT-LINE'); console.error('ERR-LINE'); process.exit(1);",
          ],
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

test("gate run preserves progress markers with redirected output", async () => {
  const root = await setupGateRoot();
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "fast"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ATO_GATE_HEARTBEAT_TICKS: "1",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes("[gate] start stderr-step"));
  assert.ok(result.stdout.includes("[gate] heartbeat stderr-step"));
  assert.ok(result.stdout.includes("[gate] end stderr-step (fail)"));
  assert.ok(result.stdout.includes("OUT-LINE"));
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes("ERR-LINE"));
});
