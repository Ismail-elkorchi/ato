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

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

test("gate retry runs only the requested step", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-retry-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "gate-retry",
    gates: {
      fast: [
        {
          id: "fast",
          cmd: ["node", "-e", "require('fs').writeFileSync('fast.txt','fast')"],
        },
      ],
      full: {
        tests: {
          root: [
            {
              id: "retry-me",
              cmd: [
                "node",
                "-e",
                "require('fs').writeFileSync('retry.txt','retry')",
              ],
            },
          ],
        },
      },
    },
  };
  await writeJson(path.join(root, storeDir, "config.json"), config);
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "retry", "--step", "retry-me", "--mode", "full", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.step, "retry-me");
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].id, "retry-me");

  assert.equal(await fileExists(path.join(root, "fast.txt")), false);
  assert.equal(await fileExists(path.join(root, "retry.txt")), true);
});
