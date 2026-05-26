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

const writeConfig = async (root, observations) => {
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "bb-show-seed",
    contracts: {
      platform: path.resolve(".ato/contracts/PLATFORM_CONTRACT.md"),
    },
    blackboard: {
      observations,
    },
  };
  await writeJson(path.join(root, ".ato", "config.json"), config);
};

const writeCatalog = async (root, entries) => {
  await writeJson(path.join(root, ".ato", "signals", "definitions.json"), entries);
};

const writeState = async (root, cycleId) => {
  await writeJson(path.join(root, ".ato", "state.json"), {
    version: 1,
    activeCycleId: cycleId,
    activeCycleQueueId: "BL-0001",
    activeCycleStartedAt: "2025-01-01T00:00:00.000Z",
  });
};

const runBbShow = (root) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(
    process.execPath,
    [cliPath, "--repo", root, "bb", "show", "--json"],
    { cwd: root, encoding: "utf8" },
  );
};

test("bb show orders signals deterministically and includes evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-show-"));
  const nodePath = process.execPath;
  const observations = [
    { id: "b_signal", cmd: [nodePath, "-e", "process.exit(0)"] },
    { id: "a_signal", cmd: [nodePath, "-e", "process.exit(0)"] },
  ];
  await writeAgents(root);
  await writeConfig(root, observations);
  await writeCatalog(root, [
    {
      name: "a_signal",
      type: "reliability",
      source: "test",
      collection_method: "cmd",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "b_signal",
      type: "cost",
      source: "test",
      collection_method: "cmd",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "agent_total_tokens",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "telemetry_missing",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
  ]);

  const first = runBbShow(root);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.schema_version, "bb-show.v2");
  const firstSignals = firstPayload.signals ?? [];
  assert.deepEqual(
    firstSignals.map((signal) => signal.kind),
    ["a_signal", "b_signal", "telemetry_missing"],
  );

  const second = runBbShow(root);
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  const secondSignals = secondPayload.signals ?? [];
  assert.deepEqual(
    secondSignals.map((signal) => signal.kind),
    ["a_signal", "b_signal", "telemetry_missing"],
  );

  const evidence = firstSignals[0]?.evidence ?? [];
  assert.ok(evidence.some((entry) => entry.startsWith("cmd:")));
});

test("bb show refuses unknown signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-show-"));
  const nodePath = process.execPath;
  const observations = [{ id: "unknown_signal", cmd: [nodePath, "-e", "process.exit(0)"] }];
  await writeAgents(root);
  await writeConfig(root, observations);
  await writeCatalog(root, [
    {
      name: "known_signal",
      type: "reliability",
      source: "test",
      collection_method: "cmd",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "agent_total_tokens",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "telemetry_missing",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
  ]);

  const result = runBbShow(root);
  const payload = JSON.parse(result.stdout);
  assert.equal(result.status, 3);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 3);
  assert.ok(
    payload.error?.details?.errors?.some((entry) =>
      String(entry).includes("Unknown signal 'unknown_signal'"),
    ),
  );
});

test("bb show prefers cycle-scoped telemetry evidence when cycle is active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-show-"));
  await writeAgents(root);
  await writeConfig(root, []);
  await writeCatalog(root, [
    {
      name: "agent_total_tokens",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
    {
      name: "telemetry_missing",
      type: "agent_telemetry",
      source: "test",
      collection_method: "report",
      evidence_format: "log",
      action_rule: "none",
    },
  ]);
  await writeState(root, "CY-TEST");

  const show = runBbShow(root);
  assert.equal(show.status, 0, show.stderr);
  const payload = JSON.parse(show.stdout);
  const telemetrySignal = (payload.signals ?? []).find(
    (signal) => signal.kind === "telemetry_missing",
  );
  assert.ok(telemetrySignal, "telemetry_missing signal missing");
  assert.equal(payload.telemetry?.cycle_id, "CY-TEST");
});
