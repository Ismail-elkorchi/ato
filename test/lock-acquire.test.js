import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireLock, getLockPath } from "../dist/core/lock.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("acquireLock reports stale pid locks without clearing", async () => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "ato-lock-"));
  const lockPath = getLockPath(store);
  await writeJson(lockPath, {
    pid: 999999,
    created_at: new Date().toISOString(),
  });

  const result = await acquireLock(store, 60 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.equal(result.lockPath, lockPath);
  assert.equal(result.current?.pid, 999999);
  const raw = await fs.readFile(lockPath, "utf8");
  const payload = JSON.parse(raw);
  assert.equal(payload.pid, 999999);
});
