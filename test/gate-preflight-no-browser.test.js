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

test("gate run --no-browser skips browser steps in json output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-nb-"));
  const storeDir = ".ato";
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "no-browser-seed",
    gates: {
      fast: [
        {
          id: "browser-test",
          cmd: [
            "node",
            "-e",
            "require('fs').writeFileSync('browser.txt','ok')",
          ],
        },
        {
          id: "unit-test",
          cmd: ["node", "-e", "require('fs').writeFileSync('unit.txt','ok')"],
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
    [cliPath, "gate", "run", "--mode", "fast", "--no-browser", "--json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const browser = payload.results.find((entry) => entry.id === "browser-test");
  assert.ok(browser);
  assert.equal(browser.status, "skipped");
  assert.equal(browser.skip_reason, "no-browser");

  const unit = payload.results.find((entry) => entry.id === "unit-test");
  assert.ok(unit);
  assert.equal(unit.status, "ok");

  assert.equal(await fileExists(path.join(root, "browser.txt")), false);
  assert.equal(await fileExists(path.join(root, "unit.txt")), true);
});
