import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts/check-policy.mjs");

const requiredPolicyArtifacts = [
  ".ato/contracts/ENGINEERING_POLICY.md",
  ".ato/library/ENGINEERING_POLICY_CHECKS.md",
  ".ato/library/ENGINEERING_POLICY_BASELINE.md",
];

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const seedPolicyArtifacts = async (root) => {
  for (const relPath of requiredPolicyArtifacts) {
    const filePath = path.join(root, relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "ok\n", "utf8");
  }
};

const runCheckPolicy = (cwd) =>
  spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });

test("check-policy accepts canonical .ato/config.json profile and no package override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-check-policy-"));
  await seedPolicyArtifacts(root);
  await writeJson(path.join(root, ".ato/config.json"), {
    stabilityProfile: "EXPERIMENTAL",
  });
  await writeJson(path.join(root, "package.json"), {
    name: "fixture",
    version: "1.0.0",
  });

  const result = runCheckPolicy(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /canonical stability profile/i);
});

test("check-policy rejects package.json ato.stabilityProfile declaration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-check-policy-"));
  await seedPolicyArtifacts(root);
  await writeJson(path.join(root, ".ato/config.json"), {
    stabilityProfile: "EXPERIMENTAL",
  });
  await writeJson(path.join(root, "package.json"), {
    name: "fixture",
    version: "1.0.0",
    ato: { stabilityProfile: "EXPERIMENTAL" },
  });

  const result = runCheckPolicy(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json must not declare ato\.stabilityProfile/i);
});

test("check-policy rejects missing .ato/config.json stabilityProfile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-check-policy-"));
  await seedPolicyArtifacts(root);
  await writeJson(path.join(root, ".ato/config.json"), {});
  await writeJson(path.join(root, "package.json"), {
    name: "fixture",
    version: "1.0.0",
  });

  const result = runCheckPolicy(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing stabilityprofile in \.ato\/config\.json/i);
});
