import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const loadRunner = async () => {
  const runnerUrl = pathToFileURL(
    path.resolve("scripts/parallel-runner.mjs"),
  ).href;
  return import(runnerUrl);
};

const writeFixtureTest = async (root) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const filePath = path.join(testDir, "fixture.test.js");
  const content = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("fixture ok", () => assert.ok(true));',
    "",
  ].join("\n");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
};

const writeFixtureTests = async (root, names) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const relPaths = [];
  for (const name of names) {
    const base = `${name}.test.js`;
    const filePath = path.join(testDir, base);
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      `test("${name} ok", () => assert.ok(true));`,
      "",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf8");
    relPaths.push(path.posix.join("test", base));
  }
  return relPaths;
};

const setupFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-shard-"));
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "runner-fixture",
        type: "module",
        version: pkg.version,
        scripts: {
          test: "node scripts/parallel-runner.mjs test/*.test.js",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const fixturePath = await writeFixtureTest(root);
  return { root, runnerPath, fixturePath };
};

const setupFixtureWithTests = async (names) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-shard-"));
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const runnerSource = await fs.readFile(
    path.resolve("scripts/parallel-runner.mjs"),
    "utf8",
  );
  const runnerPath = path.join(root, "scripts", "parallel-runner.mjs");
  await fs.mkdir(path.dirname(runnerPath), { recursive: true });
  await fs.writeFile(runnerPath, runnerSource, "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "runner-fixture",
        type: "module",
        version: pkg.version,
        scripts: {
          test: "node scripts/parallel-runner.mjs test/*.test.js",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const fixturePaths = await writeFixtureTests(root, names);
  return { root, runnerPath, fixturePaths };
};

test("test runner shard selection is deterministic", async () => {
  const { parseShardSpec, applyShard } = await loadRunner();
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const spec = parseShardSpec("2/3");
  assert.deepEqual(applyShard(items, spec), ["b", "e", "h"]);
});

test("test runner shards partition without overlap", async () => {
  const { parseShardSpec, applyShard } = await loadRunner();
  const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const total = 4;
  const seen = new Set();
  for (let i = 1; i <= total; i += 1) {
    const spec = parseShardSpec(`${i}/${total}`);
    for (const item of applyShard(items, spec)) {
      assert.equal(seen.has(item), false);
      seen.add(item);
    }
  }
  assert.equal(seen.size, items.length);
});

test("invalid shard specs reject with guidance", async () => {
  const { parseShardSpec } = await loadRunner();
  assert.throws(
    () => parseShardSpec("0/2"),
    /ATO_TEST_SHARD.*K\/N/i,
  );
  assert.throws(
    () => parseShardSpec("2/1"),
    /ATO_TEST_SHARD.*K\/N/i,
  );
  assert.throws(
    () => parseShardSpec("nope"),
    /ATO_TEST_SHARD.*K\/N/i,
  );
});

test("runner exits non-zero on invalid shard env", async () => {
  const fixture = await setupFixture();
  try {
    const env = { ...process.env, ATO_TEST_SHARD: "0/2" };
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, fixture.fixturePath],
      { cwd: fixture.root, encoding: "utf8", env },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ATO_TEST_SHARD.*K\/N/i);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner accepts --shard argument and records shard in header", async () => {
  const fixture = await setupFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, "--shard", "1/2", fixture.fixturePath],
      { cwd: fixture.root, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const headerLine = String(result.stdout || "").trim().split("\n")[0] || "";
    const header = JSON.parse(headerLine);
    assert.deepEqual(header.shard, {
      index: 1,
      count: 2,
      total: 1,
      selected: 1,
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner receipts reflect sharded execution", async () => {
  const { parseShardSpec, applyShard } = await loadRunner();
  const fixture = await setupFixtureWithTests(["alpha", "beta", "gamma"]);
  try {
    const shardRaw = "2/3";
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, "--shard", shardRaw, ...fixture.fixturePaths],
      { cwd: fixture.root, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const headerLine = String(result.stdout || "").trim().split("\n")[0] || "";
    const header = JSON.parse(headerLine);
    const receiptsPath = path.resolve(fixture.root, header.receipts_path);
    const receipts = (await fs.readFile(receiptsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const unique = Array.from(
      new Set(receipts.map((entry) => entry.test_file)),
    ).sort();
    const spec = parseShardSpec(shardRaw, "--shard");
    const expected = applyShard([...fixture.fixturePaths].sort(), spec);
    assert.deepEqual(unique, expected);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner rejects invalid --shard argument", async () => {
  const fixture = await setupFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [fixture.runnerPath, "--shard", "0/2", fixture.fixturePath],
      { cwd: fixture.root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--shard.*K\/N/i);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
