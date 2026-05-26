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

const runCommand = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

test("telemetry codex report marks missing telemetry explicitly and is deterministic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-telemetry-missing-"));
  const storeDir = ".ato";
  await writeJson(path.join(root, storeDir, "config.json"), {
    version: 1,
    targetId: "tmp",
    storeDir,
    fingerprintSeed: "seed",
  });
  await writeAgents(root);

  const first = runCommand(root, ["telemetry", "codex", "report", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout.trim());
  assert.equal(firstPayload.telemetry_missing, true);
  assert.equal(firstPayload.telemetry_missing_reason, "index_missing");
  assert.equal(firstPayload.report.extensions.codex.telemetry_missing, true);
  assert.equal(
    firstPayload.report.extensions.codex.telemetry_missing_reason,
    "index_missing",
  );
  assert.equal(firstPayload.report.counts.sessions_total, 0);

  const reportPath = path.join(
    root,
    storeDir,
    "signals",
    "codex",
    "latest.report.json",
  );
  const reportRaw = await fs.readFile(reportPath, "utf8");

  const repeat = runCommand(root, ["telemetry", "codex", "report", "--json"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  const reportRepeat = await fs.readFile(reportPath, "utf8");
  assert.equal(reportRepeat, reportRaw);
});
