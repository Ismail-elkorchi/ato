import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureEvalPreflight } from "../dist/core/eval/preflight.js";

test("cycle preflight writes repo artifact with sha256", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-preflight-"));
  const storeDir = ".ato";

  spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  await fs.writeFile(path.join(root, "README.md"), "ok\n", "utf8");

  const payload = await captureEvalPreflight({
    root,
    store: path.join(root, storeDir),
    targetId: "tmp",
  });
  assert.equal(payload.cycle_id, "CY-0001");
  assert.ok(payload.path.includes(path.join(".ato", "cycles", "CY-0001")));

  const fullPath = path.join(root, payload.path);
  const raw = await fs.readFile(fullPath, "utf8");
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  assert.equal(payload.sha256, sha);

  const content = JSON.parse(raw);
  assert.equal(content.schema_version, "eval-preflight.v1");
  assert.equal(content.cycle.id, "CY-0001");
  assert.equal(content.node.version, process.version);
});
