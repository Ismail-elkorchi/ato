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

test("gate json reports touched_files for steps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-touched-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "touched-seed",
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

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "gate", "run", "--mode", "fast", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.results));
  assert.equal(payload.results[0].id, "touch");
  assert.ok(payload.results[0].touched_files.includes("touched.txt"));

  const sorted = [...payload.results[0].touched_files].sort();
  assert.deepEqual(payload.results[0].touched_files, sorted);
});
