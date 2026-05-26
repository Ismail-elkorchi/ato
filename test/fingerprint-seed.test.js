import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTarget, TargetError } from "../dist/core/targets/resolve.js";

test("resolveTarget requires fingerprintSeed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-seed-"));
  const storeDir = ".ato";
  await fs.mkdir(path.join(root, storeDir), { recursive: true });
  const config = {
    version: 1,
    targetId: "example",
    storeDir,
  };
  await fs.writeFile(
    path.join(root, ".ato", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    () => resolveTarget({ cwd: root, selection: null, requireWrite: false }),
    (error) =>
      error instanceof TargetError &&
      /fingerprintSeed/.test(String(error.message)),
  );
});
