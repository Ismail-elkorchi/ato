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

const runCommand = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

test("telemetry codex report aggregates deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-report-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n",
    "utf8",
  );

  const fixturePath = path.resolve("test/fixtures/codex/session.jsonl");
  const fixtureRaw = await fs.readFile(fixturePath, "utf8");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, "b.jsonl"), fixtureRaw, "utf8");
  await fs.writeFile(
    path.join(sessionsDir, "a.jsonl"),
    fixtureRaw.replace("session-001", "session-002"),
    "utf8",
  );

  const ingest = runCommand(root, [
    "telemetry",
    "codex",
    "ingest",
    "--path",
    sessionsDir,
    "--json",
  ]);
  assert.equal(ingest.status, 0);

  const report = runCommand(root, ["telemetry", "codex", "report", "--json"]);
  assert.equal(report.status, 0);

  const reportPath = path.join(root, storeDir, "signals", "codex", "latest.report.json");
  const reportRaw = await fs.readFile(reportPath, "utf8");
  const reportPayload = JSON.parse(reportRaw);

  assert.equal(reportPayload.totals.input_tokens, 200);
  assert.equal(reportPayload.totals.cached_input_tokens, 10);
  assert.equal(reportPayload.totals.output_tokens, 100);
  assert.equal(reportPayload.totals.total_tokens, 300);
  assert.equal(reportPayload.totals.context_window, 8192);
  assert.equal(reportPayload.totals.tool_calls_count, 2);
  assert.equal(reportPayload.totals.error_count, 2);
  assert.equal(reportPayload.averages.total_tokens, 150);
  assert.equal(reportPayload.extensions.codex.totals.shell_commands_total, 4);
  assert.equal(reportPayload.extensions.codex.telemetry_missing, false);
  assert.equal(reportPayload.extensions.codex.telemetry_missing_reason ?? null, null);

  assert.ok(!reportRaw.includes("do not store this text"));
  assert.ok(!reportRaw.includes("/tmp/outside"));

  const indexPath = path.join(root, storeDir, "signals", "codex", "index.jsonl");
  const indexRaw = await fs.readFile(indexPath, "utf8");
  const indexEntries = indexRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(indexEntries.length, 1);

  const repeat = runCommand(root, ["telemetry", "codex", "report", "--json"]);
  assert.equal(repeat.status, 0);
  const reportRepeat = await fs.readFile(reportPath, "utf8");
  const indexRepeat = await fs.readFile(indexPath, "utf8");
  assert.equal(reportRepeat, reportRaw);
  assert.equal(indexRepeat, indexRaw);
});
