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
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: "telemetry-seed",
    contracts: {
      platform: path.resolve(".ato/contracts/PLATFORM_CONTRACT.md"),
    },
    blackboard: {
      observations: [],
    },
  };
  await writeJson(path.join(root, ".ato", "config.json"), config);
};

const writeCatalog = async (root) => {
  const catalog = [
    {
      name: "agent_total_tokens",
      type: "agent_telemetry",
      source: "test",
      collection_method: "telemetry codex report",
      evidence_format: "report",
      action_rule: "none",
    },
    {
      name: "telemetry_missing",
      type: "agent_telemetry",
      source: "test",
      collection_method: "telemetry codex report",
      evidence_format: "report",
      action_rule: "none",
    },
  ];
  await writeJson(path.join(root, ".ato", "signals", "definitions.json"), catalog);
};

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

test("telemetry ingest is deterministic and redacted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-"));
  const fixture = path.resolve("test/fixtures/telemetry/codex/session.jsonl");
  await writeAgents(root);
  await writeConfig(root);

  const first = runCli(root, [
    "telemetry",
    "codex",
    "ingest",
    "--path",
    fixture,
    "--json",
  ]);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  const summaryRel = firstPayload.outputs.summaries[0].path;
  const summaryPath = path.join(root, summaryRel);
  const firstSummary = await fs.readFile(summaryPath, "utf8");

  const second = runCli(root, [
    "telemetry",
    "codex",
    "ingest",
    "--path",
    fixture,
    "--json",
  ]);
  assert.equal(second.status, 0, second.stderr);
  const secondSummary = await fs.readFile(summaryPath, "utf8");

  assert.equal(firstSummary, secondSummary);
  assert.ok(!firstSummary.includes("TOP SECRET INSTRUCTIONS"));
  assert.ok(!firstSummary.includes("/home/testuser"));
  assert.ok(!firstSummary.includes("\"balance\""));
  assert.ok(!firstSummary.includes("12.34"));

  const summaryJson = JSON.parse(firstSummary);
  assert.ok(summaryJson.integrity?.source_file_hash);
  assert.equal(summaryJson.integrity?.redaction_profile_id, "codex-session-redaction.v1");
  assert.ok(summaryJson.instructions_hash);
  assert.equal(summaryJson.counts?.tool_calls, 1);
  assert.equal(summaryJson.counts?.shell_commands, 2);
});

test("telemetry report emits canonical metrics and codex extensions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-"));
  const fixture = path.resolve("test/fixtures/telemetry/codex/session.jsonl");
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const ingest = runCli(root, [
    "telemetry",
    "codex",
    "ingest",
    "--path",
    fixture,
    "--json",
  ]);
  assert.equal(ingest.status, 0, ingest.stderr);

  const report = runCli(root, [
    "telemetry",
    "codex",
    "report",
    "--cycle-id",
    "CY-TEST",
    "--json",
  ]);
  assert.equal(report.status, 0, report.stderr);
  const payload = JSON.parse(report.stdout);
  const totals = payload.report.totals;
  assert.equal(totals.input_tokens, 120);
  assert.equal(totals.cached_input_tokens, 20);
  assert.equal(totals.output_tokens, 60);
  assert.equal(totals.total_tokens, 180);
  assert.equal(totals.context_window, 8192);
  assert.equal(totals.tool_calls_count, 1);
  assert.equal(totals.error_count, 1);
  assert.ok(payload.report.extensions?.codex);
  assert.equal(payload.report.extensions.codex.telemetry_missing, false);
  assert.equal(payload.report.extensions.codex.telemetry_missing_reason ?? null, null);
  assert.ok(payload.outputs.report_path.includes("reports/CY-TEST.report.json"));
  assert.ok(payload.outputs.latest_report_path.endsWith("latest.report.json"));
});

test("bb show emits telemetry_missing when telemetry is absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-"));
  await writeAgents(root);
  await writeConfig(root);
  await writeCatalog(root);

  const show = runCli(root, ["bb", "show", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  const payload = JSON.parse(show.stdout);
  const kinds = (payload.signals ?? []).map((signal) => signal.kind);
  assert.ok(kinds.includes("telemetry_missing"));
});
