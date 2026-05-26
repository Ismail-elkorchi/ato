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

test("pack verify validates pack sha and manifest entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-pack-verify-"));
  const store = path.join(root, ".ato");
  await fs.mkdir(store, { recursive: true });

  const cycleId = "CY-0001";
  const required = requiredCyclePackEntries(cycleId);
  const entries = [];
  for (const rel of required) {
    const abs = path.join(root, rel);
    await writeJson(abs, { ok: true });
    entries.push(abs);
  }

  const { pack_ref: packRef } = await buildCycleEvidencePack({
    root,
    store,
    cycleId,
    entries,
  });

  const verified = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.missing_required.length, 0);
  assert.equal(verified.failures.length, 0);
  assert.equal(verified.verified_files_count, entries.length);

  await fs.appendFile(path.join(root, packRef.path), "tamper", "utf8");
  const tampered = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
  });
  assert.equal(tampered.ok, false);
  assert.ok(
    tampered.failures.some((entry) =>
      ["pack_sha_mismatch", "manifest_pack_sha_mismatch"].includes(entry.type),
    ),
  );
});
