import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

const writeTestFile = async (root, relPath) => {
  const filePath = path.join(root, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("fixture", () => assert.ok(true));',
      "",
    ].join("\n"),
    "utf8",
  );
};

const runDiscovery = (cwd, runnerUrl, args) => {
  const script = [
    "import { discoverTestFiles, computeTestFileId } from",
    `${JSON.stringify(runnerUrl)};`,
    "const args = JSON.parse(process.argv[1]);",
    "const list = discoverTestFiles(args, process.cwd()).map((rel) => ({",
    "  path: rel,",
    "  id: computeTestFileId(rel, process.cwd()),",
    "}));",
    "process.stdout.write(JSON.stringify(list));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script, JSON.stringify(args)], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, stderr: result.stderr, status: result.status };
  }
  return { ok: true, data: JSON.parse(result.stdout.trim()) };
};

const hashId = (relPath) =>
  crypto.createHash("sha256").update(relPath).digest("hex");

const writePolicyEvidence = async (payload) => {
  try {
    const stateRaw = await fs.readFile(
      path.resolve(".ato", "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateRaw);
    const cycleId = state?.activeCycleId;
    if (!cycleId) return;
    const evidencePath = path.join(
      process.cwd(),
      ".ato",
      "cycles",
      cycleId,
      "acceptance-discovery-policy.json",
    );
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // ignore if not in a cycle
  }
};

test("test discovery ordering and ids are deterministic across processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-discovery-"));
  try {
    await writeTestFile(root, "test/a.test.js");
    await writeTestFile(root, "test/b.test.js");
    await writeTestFile(root, "test/holdout/c.test.js");
    let symlinkPolicy = "denied";
    try {
      await fs.symlink(
        path.join(root, "test", "a.test.js"),
        path.join(root, "test", "link-a.test.js"),
      );
    } catch (error) {
      if (error?.code === "EPERM") {
        symlinkPolicy = "unsupported";
      } else {
        throw error;
      }
    }

    const runnerUrl = pathToFileURL(
      path.resolve("scripts/parallel-runner.mjs"),
    ).href;
    const args = [
      "test/*.test.js",
      path.join("test", "..", "test", "b.test.js"),
      "./test/a.test.js",
      "test/holdout/*.test.js",
    ];

    const first = runDiscovery(root, runnerUrl, args);
    const second = runDiscovery(root, runnerUrl, args);
    assert.equal(first.ok, true, first.stderr);
    assert.equal(second.ok, true, second.stderr);

    assert.deepEqual(first.data, second.data);
    const expected = [
      "test/a.test.js",
      "test/b.test.js",
      "test/holdout/c.test.js",
    ];
    assert.deepEqual(first.data.map((entry) => entry.path), expected);
    assert.equal(new Set(first.data.map((entry) => entry.path)).size, expected.length);
    for (const entry of first.data) {
      assert.equal(entry.id, hashId(entry.path));
    }
    await writePolicyEvidence({
      policy: {
        symlink: symlinkPolicy,
        duplicates: "dedupe-normalized-paths",
      },
      expected,
      discovered_count: first.data.length,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discovery rejects paths outside repo root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-discovery-"));
  try {
    await writeTestFile(root, "test/a.test.js");
    const runnerUrl = pathToFileURL(
      path.resolve("scripts/parallel-runner.mjs"),
    ).href;
    const outsidePath = path.join(root, "..", "outside.test.js");
    const result = runDiscovery(root, runnerUrl, [outsidePath]);
    assert.equal(result.ok, false);
    assert.match(String(result.stderr), /outside repo root/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
