import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const SKIP_CHILD = process.env.ATO_PARALLEL_INVARIANTS_CHILD === "1";

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const shouldIgnore = (relPath) => {
  if (!relPath) return true;
  if (relPath === ".git" || relPath.startsWith(".git/")) return true;
  if (relPath === "node_modules" || relPath.startsWith("node_modules/")) {
    return true;
  }
  if (relPath === ".ato" || relPath.startsWith(".ato/")) return true;
  if (relPath === "dist" || relPath.startsWith("dist/")) return true;
  if (relPath === "coverage" || relPath.startsWith("coverage/")) return true;
  return false;
};

const snapshotTree = async (root) => {
  const files = new Map();

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, "/");
      if (shouldIgnore(relPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.set(relPath, await hashFile(fullPath));
      } else if (entry.isSymbolicLink()) {
        files.set(relPath, "symlink");
      }
    }
  };

  await walk(root);
  return files;
};

const diffSnapshots = (before, after) => {
  const changes = [];
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  for (const key of allKeys) {
    if (before.get(key) !== after.get(key)) {
      changes.push(key);
    }
  }
  return changes.sort((a, b) => a.localeCompare(b));
};

const assertNoUnexpectedWrites = (before, after) => {
  const changes = diffSnapshots(before, after);
  if (changes.length > 0) {
    throw new Error(`Unexpected writes detected: ${changes.join(", ")}`);
  }
};

const isAllowedAtoPath = (relPath) => {
  if (!relPath.startsWith(".ato/")) return false;
  if (relPath.startsWith(".ato/cycles/")) return true;
  return false;
};

const snapshotSensitivePaths = async (root) => {
  const snapshots = new Map();
  const addIfExists = async (relPath) => {
    const fullPath = path.join(root, relPath);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        snapshots.set(relPath, await hashFile(fullPath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  };

  await addIfExists("package-lock.json");
  await addIfExists("pnpm-lock.yaml");
  await addIfExists("yarn.lock");

  const atoRoot = path.join(root, ".ato");
  try {
    const entries = await fs.readdir(atoRoot, { withFileTypes: true });
    const walk = async (dir) => {
      const rel = path
        .relative(root, dir)
        .replace(/\\/g, "/");
      if (rel === ".ato") {
        // continue walking into .ato
      } else if (rel.startsWith(".ato/") && isAllowedAtoPath(rel)) {
        return;
      }
      const localEntries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of localEntries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = path
            .relative(root, fullPath)
            .replace(/\\/g, "/");
          if (!isAllowedAtoPath(relPath)) {
            snapshots.set(relPath, await hashFile(fullPath));
          }
        }
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(atoRoot, entry.name));
      } else if (entry.isFile()) {
        const relPath = `.ato/${entry.name}`;
        if (!isAllowedAtoPath(relPath)) {
          snapshots.set(relPath, await hashFile(path.join(atoRoot, entry.name)));
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return snapshots;
};

const assertSensitiveUnchanged = (before, after) => {
  const changes = diffSnapshots(before, after);
  if (changes.length > 0) {
    throw new Error(`Sensitive writes detected: ${changes.join(", ")}`);
  }
};

const resolveTempBase = (root) => {
  const tmpRoot = os.tmpdir();
  const rel = path.relative(root, tmpRoot);
  const isInsideRoot =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isInsideRoot) return tmpRoot;
  return path.join(path.dirname(root), ".ato-test-tmp");
};

const shouldSkipCopy = (root, srcPath) => {
  const rel = path.relative(root, srcPath).replace(/\\/g, "/");
  if (rel === ".ato/tmp" || rel.startsWith(".ato/tmp/")) return true;
  return false;
};

const copyRepo = async (root) => {
  const tempBase = resolveTempBase(root);
  await fs.mkdir(tempBase, { recursive: true });
  const tempRoot = await fs.mkdtemp(
    path.join(tempBase, "ato-parallel-invariants-"),
  );
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === ".ato" ||
      entry.name === "dist" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const source = path.join(root, entry.name);
    const dest = path.join(tempRoot, entry.name);
    await fs.cp(source, dest, {
      recursive: true,
      filter: (srcPath) => !shouldSkipCopy(root, srcPath),
    });
  }

  const nodeModules = path.join(root, "node_modules");
  try {
    await fs.access(nodeModules);
  } catch {
    throw new Error("node_modules is required to run npm test in fixture.");
  }
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(nodeModules, path.join(tempRoot, "node_modules"), linkType);
  return tempRoot;
};

const writeFixtureTest = async (root) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const fixturePath = path.join(testDir, "parallel-invariants-fixture.test.js");
  const contents = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    'test("parallel invariants fixture", () => {',
    "  assert.equal(1, 1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(fixturePath, contents, "utf8");
  return fixturePath;
};

const runNpmTest = (cwd, envOverrides, testPath) => {
  const result = spawnSync(
    process.execPath,
    ["scripts/parallel-runner.mjs", testPath],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...envOverrides },
    },
  );
  return result;
};

test(
  "parallel invariants detect forbidden writes (negative control)",
  { skip: SKIP_CHILD ? "child run" : undefined },
  async () => {
    const root = path.resolve(".");
    const tempRoot = await copyRepo(root);
    try {
      const before = await snapshotTree(tempRoot);
      await fs.writeFile(
        path.join(tempRoot, "forbidden.tmp"),
        "should fail\n",
        "utf8",
      );
      const after = await snapshotTree(tempRoot);
      assert.throws(
        () => assertNoUnexpectedWrites(before, after),
        /forbidden\.tmp/,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "parallel invariants flag sensitive path writes (negative control)",
  { skip: SKIP_CHILD ? "child run" : undefined },
  async () => {
    const root = path.resolve(".");
    const tempRoot = await copyRepo(root);
    try {
      const before = await snapshotSensitivePaths(tempRoot);
      await fs.writeFile(
        path.join(tempRoot, "package-lock.json"),
        "forbidden lockfile\n",
        "utf8",
      );
      const after = await snapshotSensitivePaths(tempRoot);
      assert.throws(
        () => assertSensitiveUnchanged(before, after),
        /package-lock\.json/,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "parallel test runs do not write unexpected files outside allowlist",
  { skip: SKIP_CHILD ? "child run" : undefined },
  async () => {
    const root = path.resolve(".");
    const tempRoot = await copyRepo(root);
    try {
      const fixturePath = await writeFixtureTest(tempRoot);
      const before = await snapshotTree(tempRoot);
      const sensitiveBefore = await snapshotSensitivePaths(tempRoot);

      const serial = runNpmTest(tempRoot, {
        ATO_PARALLEL_INVARIANTS_CHILD: "1",
        ATO_TEST_CONCURRENCY: "1",
      }, fixturePath);
      assert.equal(
        serial.status,
        0,
        serial.stderr || serial.stdout || "serial npm test failed",
      );

      const parallel = runNpmTest(tempRoot, {
        ATO_PARALLEL_INVARIANTS_CHILD: "1",
        ATO_TEST_CONCURRENCY: "auto",
      }, fixturePath);
      assert.equal(
        parallel.status,
        0,
        parallel.stderr || parallel.stdout || "parallel npm test failed",
      );

      const after = await snapshotTree(tempRoot);
      assertNoUnexpectedWrites(before, after);
      const sensitiveAfter = await snapshotSensitivePaths(tempRoot);
      assertSensitiveUnchanged(sensitiveBefore, sensitiveAfter);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
