import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listStateSnapshots,
  filterStateSnapshots,
} from "../dist/core/memory/state.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
};

const makeSnapshot = ({ id, createdAt }) => ({
  id,
  type: "state",
  createdAt,
  git: {
    branch: "main",
    head: "deadbeef",
    status: [],
  },
  env: {
    node: "v20.19.0",
    platform: "linux",
    cwd: "/tmp",
  },
});

test("listStateSnapshots orders by createdAt and id", async () => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "ato-state-"));
  const dir = path.join(store, "memory", "state");
  const snapshots = [
    makeSnapshot({
      id: "state-2025-01-02T00-00-00-000Z",
      createdAt: "2025-01-02T00:00:00.000Z",
    }),
    makeSnapshot({
      id: "state-2025-01-01T00-00-00-001Z",
      createdAt: "2025-01-01T00:00:00.000Z",
    }),
    makeSnapshot({
      id: "state-2025-01-01T00-00-00-000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
    }),
  ];
  for (const snapshot of snapshots) {
    await writeJson(path.join(dir, `${snapshot.id}.json`), snapshot);
  }
  await writeJson(path.join(dir, "latest.json"), snapshots[0]);

  const ordered = await listStateSnapshots(store);
  assert.deepEqual(
    ordered.map((snapshot) => snapshot.id),
    [
      "state-2025-01-01T00-00-00-000Z",
      "state-2025-01-01T00-00-00-001Z",
      "state-2025-01-02T00-00-00-000Z",
    ],
  );
});

test("filterStateSnapshots applies since/until/limit", async () => {
  const snapshots = [
    makeSnapshot({
      id: "state-2025-01-01T00-00-00-000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
    }),
    makeSnapshot({
      id: "state-2025-01-02T00-00-00-000Z",
      createdAt: "2025-01-02T00:00:00.000Z",
    }),
    makeSnapshot({
      id: "state-2025-01-03T00-00-00-000Z",
      createdAt: "2025-01-03T00:00:00.000Z",
    }),
  ];
  const filtered = filterStateSnapshots({
    snapshots,
    since: "2025-01-02T00:00:00.000Z",
    until: "2025-01-03T00:00:00.000Z",
    limit: 1,
  });
  assert.deepEqual(filtered.map((snapshot) => snapshot.id), [
    "state-2025-01-02T00-00-00-000Z",
  ]);
});
