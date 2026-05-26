import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCycleEvidencePack,
  verifyCycleEvidencePack,
  requiredCyclePackEntries,
} from "../dist/core/cycle/pack.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("pack verify flags absolute paths in JSON artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-pack-abs-"));
  const store = path.join(root, ".ato");
  await fs.mkdir(store, { recursive: true });

  const cycleId = "CY-0003";
  const entries = [];
  for (const rel of requiredCyclePackEntries(cycleId)) {
    const abs = path.join(root, rel);
    await writeJson(abs, { ok: true });
    entries.push(abs);
  }
  const extraRel = `.ato/cycles/${cycleId}/telemetry.json`;
  const extraAbs = path.join(root, extraRel);
  await writeJson(extraAbs, { path: "/home/user/secret" });
  entries.push(extraAbs);

  const { pack_ref: packRef } = await buildCycleEvidencePack({
    root,
    store,
    cycleId,
    entries,
  });

  const result = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
  });

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((entry) => entry.type === "absolute_path"));
});
