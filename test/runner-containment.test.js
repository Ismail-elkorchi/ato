import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const loadContainment = async () => {
  const runnerUrl = pathToFileURL(
    path.resolve("scripts/parallel-runner.mjs"),
  ).href;
  const mod = await import(runnerUrl);
  if (typeof mod.isRealpathContained !== "function") {
    throw new Error("isRealpathContained missing from runner module.");
  }
  return mod.isRealpathContained;
};

test("isRealpathContained rejects prefix-only matches", async () => {
  const isRealpathContained = await loadContainment();
  const root = "/repo";
  const escape = "/repoX/child";
  const allowed = "/repo/child";
  assert.equal(isRealpathContained(root, allowed).ok, true);
  assert.equal(isRealpathContained(root, escape).ok, false);
});

test("isRealpathContained handles platform-specific roots", async () => {
  const isRealpathContained = await loadContainment();
  if (process.platform === "win32") {
    assert.equal(isRealpathContained("C:\\Repo", "c:\\repo\\child").ok, true);
    assert.equal(isRealpathContained("C:\\Repo", "D:\\Repo\\child").ok, false);
  } else {
    assert.equal(isRealpathContained("/repo", "/repo").ok, true);
    assert.equal(isRealpathContained("/repo", "/repo/child").ok, true);
    assert.equal(isRealpathContained("/repo", "/other/child").ok, false);
  }
});

test("isRealpathContained enforces separator boundaries", async () => {
  const isRealpathContained = await loadContainment();
  if (process.platform !== "win32") {
    assert.equal(isRealpathContained("/repo", "/repoX").ok, false);
    assert.equal(isRealpathContained("/repo", "/repoX/child").ok, false);
    assert.equal(isRealpathContained("/repo", "/repo/../repoX").ok, false);
  }
});
