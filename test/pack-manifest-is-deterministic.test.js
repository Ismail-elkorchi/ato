import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCycleEvidencePack } from "../dist/core/cycle/pack.js";

test("cycle pack manifest and tar are deterministic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-pack-determinism-"));
  const store = path.join(root, ".ato");
  await fs.mkdir(store, { recursive: true });

  const fileA = path.join(root, "alpha.txt");
  const fileB = path.join(root, "beta.txt");
  await fs.writeFile(fileA, "alpha", "utf8");
  await fs.writeFile(fileB, "beta", "utf8");

  const first = await buildCycleEvidencePack({
    root,
    store,
    cycleId: "CY-0001",
    entries: [fileB, fileA],
  });
  const manifestPath = path.join(root, first.pack_ref.manifest_path);
  const manifestOne = await fs.readFile(manifestPath, "utf8");
  const shaOne = first.pack_ref.sha256;

  const second = await buildCycleEvidencePack({
    root,
    store,
    cycleId: "CY-0001",
    entries: [fileA, fileB],
  });
  const manifestTwo = await fs.readFile(manifestPath, "utf8");
  const shaTwo = second.pack_ref.sha256;

  assert.equal(manifestOne, manifestTwo);
  assert.equal(shaOne, shaTwo);
});
