import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGates } from "../dist/core/gates/runner.js";

test("gate artifacts include stderr tail for failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-gate-artifact-"));
  const artifactsDir = path.join(root, "artifacts");
  const config = {
    gates: {
      fast: [
        {
          id: "fail",
          cmd: [
            "node",
            "-e",
            "console.error('ERR-LINE-1'); console.error('ERR-LINE-2'); process.exit(1);",
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
  assert.equal(gate.results.length, 1);
  const artifactPath = gate.results[0]?.artifact;
  assert.ok(artifactPath);
  const content = await fs.readFile(artifactPath, "utf8");
  assert.ok(content.includes("stderr (tail"));
  assert.ok(content.includes("ERR-LINE-2"));
  assert.ok(content.includes("Exit: 1"));
});
