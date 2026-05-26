import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cliPath = path.resolve("dist/cli/main.js");

const snapshotFile = (filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return { exists: false, mtimeMs: null, size: null };
  }
};

test("route index --help prints usage without executing index", () => {
  const indexPath = path.resolve(".ato/cache/routes.index.json");
  const before = snapshotFile(indexPath);

  const result = spawnSync(process.execPath, [cliPath, "route", "index", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: ato route index \[options\]/);
  assert.equal(result.stdout.includes("routes:"), false, result.stdout);
  assert.equal(result.stdout.includes("index:"), false, result.stdout);

  const after = snapshotFile(indexPath);
  assert.deepEqual(after, before);
});

test("route pack --help prints usage without requiring --path", () => {
  const result = spawnSync(process.execPath, [cliPath, "route", "pack", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: ato route pack --path <file> \[options\]/);
  assert.equal(result.stdout.includes("Missing required --path."), false, result.stdout);
});
