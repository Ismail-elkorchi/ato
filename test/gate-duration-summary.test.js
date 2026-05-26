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

test("gate json includes duration fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-duration-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "duration-seed",
    gates: {
      fast: [
        {
          id: "ok",
          cmd: ["node", "-e", "process.exit(0)"]
        }
      ]
    }
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
    [cliPath, "gate", "run", "--mode", "fast", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.total_duration_ms, "number");
  assert.ok(payload.total_duration_ms >= 0);
  assert.ok(Array.isArray(payload.results));
  for (const entry of payload.results) {
    const duration = entry.durationMs ?? entry.duration_ms;
    assert.equal(typeof duration, "number");
    assert.ok(duration >= 0);
  }
});
