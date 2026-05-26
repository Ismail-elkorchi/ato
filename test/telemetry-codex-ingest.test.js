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

const runIngest = (root, ingestPath) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(
    process.execPath,
    [
      cliPath,
      "--repo",
      root,
      "telemetry",
      "codex",
      "ingest",
      "--path",
      ingestPath,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
};

test("telemetry codex ingest normalizes deterministically and redacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-"));
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

  const first = runIngest(root, sessionsDir);
  assert.equal(first.status, 0);
  const firstPayload = JSON.parse(first.stdout.trim());
  assert.equal(firstPayload.ok, true);
  assert.equal(firstPayload.outputs.summaries.length, 2);

  const summaryOnePath = path.join(
    root,
    storeDir,
    "telemetry",
    "codex",
    "sessions",
    "session-001.summary.json",
  );
  const summaryTwoPath = path.join(
    root,
    storeDir,
    "telemetry",
    "codex",
    "sessions",
    "session-002.summary.json",
  );
  const summaryOneRaw = await fs.readFile(summaryOnePath, "utf8");
  const summaryTwoRaw = await fs.readFile(summaryTwoPath, "utf8");

  const summary = JSON.parse(summaryOneRaw);
  assert.equal(summary.token_summary.input_tokens, 100);
  assert.equal(summary.token_summary.cached_input_tokens, 5);
  assert.equal(summary.token_summary.output_tokens, 50);
  assert.equal(summary.token_summary.total_tokens, 150);
  assert.equal(summary.counts.tool_calls, 1);
  assert.equal(summary.counts.shell_commands, 2);
  assert.equal(summary.counts.messages_user, 1);
  assert.equal(summary.counts.messages_assistant, 1);
  assert.equal(summary.counts.errors, 1);
  assert.equal(summary.rate_limit_info_present, true);
  assert.ok(summary.cwd_hash);
  assert.equal(summary.cwd_rel ?? null, null);

  const indexPath = path.join(root, storeDir, "telemetry", "codex", "index.jsonl");
  const indexRaw = await fs.readFile(indexPath, "utf8");
  const indexEntries = indexRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(indexEntries.map((entry) => entry.session_id), [
    "session-002",
    "session-001",
  ]);

  assert.ok(!summaryOneRaw.includes("do not store this text"));
  assert.ok(!summaryTwoRaw.includes("do not store this text"));
  assert.ok(!indexRaw.includes("do not store this text"));
  assert.ok(!summaryOneRaw.includes("/tmp/outside"));

  const second = runIngest(root, sessionsDir);
  assert.equal(second.status, 0);
  const summaryOneRawRepeat = await fs.readFile(summaryOnePath, "utf8");
  const summaryTwoRawRepeat = await fs.readFile(summaryTwoPath, "utf8");
  const indexRawRepeat = await fs.readFile(indexPath, "utf8");

  assert.equal(summaryOneRawRepeat, summaryOneRaw);
  assert.equal(summaryTwoRawRepeat, summaryTwoRaw);
  assert.equal(indexRawRepeat, indexRaw);
});
