import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeAgents = async (root) => {
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );
};

const writeConfig = async (root) => {
  await writeJson(path.join(root, ".ato", "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "seed",
  });
};

const initGit = (root) => {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
};

const commitAll = (root) => {
  const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
};

test("status reports active cycle with relative paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-status-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);

  const cycleId = "CY-0001";
  const cycleDir = path.join(root, ".ato", "cycles", cycleId);
  await writeJson(path.join(cycleDir, "preflight.json"), { ok: true });
  await writeJson(path.join(cycleDir, "selection.json"), { ok: true });
  await writeJson(path.join(cycleDir, "cycle-start.json"), { ok: true });
  await writeJson(path.join(cycleDir, "cycle-state.json"), {
    schema_version: "cycle-state.v1",
    cycle_id: cycleId,
    queue_id: "BL-0001",
    started_at: "2026-01-01T00:00:00.000Z",
    block_id: "block-0005",
    selection_path: ".ato/cycles/CY-0001/selection.json",
    preflight: { path: ".ato/cycles/CY-0001/preflight.json", sha256: "" },
  });
  await writeJson(path.join(root, ".ato", "state.json"), {
    version: 1,
    targetId: "tmp",
    activeCycleId: cycleId,
    activeCycleQueueId: "BL-0001",
    activeCycleStartedAt: "2026-01-01T00:00:00.000Z",
  });
  commitAll(root);

  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, "status.v2");
  assert.equal("intent_summary" in payload, false);
  assert.equal("intent" in payload, false);
  assert.equal(payload.selected_queue_id, "BL-0001");
  assert.equal(
    payload.next_action,
    "ato cycle abort --reason \"block config missing (block-0005)\" --json",
  );
  assert.equal(payload.next_action_state, "abort_required");
  assert.equal(payload.next_action_reason, "abort_reason_present");
  assert.equal(payload.next_action_source, "status-transition-registry.v1");
  assert.equal(payload.dirty_tree, false);
  assert.deepEqual(payload.dirty_paths, []);
  assert.ok(payload.active_cycle);
  assert.equal(payload.active_cycle.id, cycleId);

  const output = JSON.stringify(payload);
  assert.ok(!output.includes(root));
  if (payload.active_cycle?.paths) {
    for (const value of Object.values(payload.active_cycle.paths)) {
      assert.ok(typeof value === "string");
      assert.ok(!value.startsWith("/"));
    }
  }
});
