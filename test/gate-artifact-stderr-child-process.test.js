import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGates } from "../dist/core/gates/runner.js";

test("gate artifacts capture stderr from child processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-child-"));
  const artifactsDir = path.join(root, "artifacts");
  const config = {
    gates: {
      fast: [
        {
          id: "child-fail",
          cmd: [
            "node",
            "-e",
            "const { spawnSync } = require('child_process'); spawnSync(process.execPath, ['-e', \"console.error('CHILD-ERR');\"], { stdio: 'inherit' }); process.exit(1);",
          ],
        },
      ],
    },
  };

  const gate = await runGates({
    root,
    targetId: "tmp",
    queueId: null,
    mode: "fast",
    config,
    artifactsDir,
    env: process.env,
  });

  assert.equal(gate.ok, false);
  const artifactPath = gate.results[0]?.artifact;
  assert.ok(artifactPath);
  const content = await fs.readFile(artifactPath, "utf8");
  assert.ok(content.includes("stderr (tail"));
  assert.ok(content.includes("CHILD-ERR"));
});
