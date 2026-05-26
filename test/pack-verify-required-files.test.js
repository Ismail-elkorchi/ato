import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCycleEvidencePack,
  verifyCycleEvidencePack,
} from "../dist/core/eval/pack.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("pack verify fails when required entries are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-pack-required-"));
  const store = path.join(root, ".ato");
  await fs.mkdir(store, { recursive: true });

  const cycleId = "CY-0002";
  const preflightRel = `.ato/cycles/${cycleId}/preflight.json`;
  const preflightAbs = path.join(root, preflightRel);
  await writeJson(preflightAbs, { ok: true });

  const { pack_ref: packRef } = await buildCycleEvidencePack({
    root,
    store,
    cycleId,
    entries: [preflightAbs],
  });

  const result = await verifyCycleEvidencePack({
    root,
    packPath: packRef.path,
    manifestPath: packRef.manifest_path,
    expectedPackSha: packRef.sha256,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.missing_required.includes(`.ato/cycles/${cycleId}/selection.json`),
  );
  assert.ok(
    result.missing_required.includes(
      `.ato/cycles/${cycleId}/contract-index.json`,
    ),
  );
  assert.ok(
    result.missing_required.includes(
      `.ato/cycles/${cycleId}/contract-extract.json`,
    ),
  );
});
