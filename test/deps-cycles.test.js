import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDepsCycles } from "../dist/core/deps/index.js";

test("detectDepsCycles finds cycles deterministically", () => {
  const graph = {
    version: 1,
    packages: [
      { name: "a", path: "a", manifest: "a/package.json" },
      { name: "b", path: "b", manifest: "b/package.json" },
      { name: "c", path: "c", manifest: "c/package.json" },
    ],
    edges: [
      { from: "a", to: "b", reason: "dependencies", spec: "*" },
      { from: "b", to: "c", reason: "dependencies", spec: "*" },
      { from: "c", to: "a", reason: "dependencies", spec: "*" },
    ],
  };
  const cycles = detectDepsCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]?.path, ["a", "b", "c", "a"]);
});

test("detectDepsCycles returns empty when acyclic", () => {
  const graph = {
    version: 1,
    packages: [
      { name: "a", path: "a", manifest: "a/package.json" },
      { name: "b", path: "b", manifest: "b/package.json" },
    ],
    edges: [{ from: "a", to: "b", reason: "dependencies", spec: "*" }],
  };
  const cycles = detectDepsCycles(graph);
  assert.deepEqual(cycles, []);
});
