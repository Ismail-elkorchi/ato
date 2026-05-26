import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readEvalScorecard } from "../dist/core/eval/ledger.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
};

test("eval scorecard aggregates telemetry fields deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-eval-telemetry-"));
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

  const records = [
    {
      id: "CY-0001",
      ts: "2025-01-01T00:00:00.000Z",
      hypothesis: "telemetry summary",
      acceptance_checks: ["cmd:echo ok"],
      evidence: ["output:ok"],
      outcome: "ok",
      negative_report: {
        type: "cost",
        summary: "telemetry captured",
        evidence: ["output:ok"],
      },
      telemetry_summary: {
        tokens_total: 150,
        tool_calls_total: 1,
        shell_commands_total: 2,
      },
    },
    {
      id: "CY-0002",
      ts: "2025-01-02T00:00:00.000Z",
      hypothesis: "telemetry missing",
      acceptance_checks: ["cmd:echo ok"],
      evidence: ["output:ok"],
      outcome: "ok",
      negative_report: {
        type: "cost",
        summary: "telemetry missing",
        evidence: ["output:ok"],
      },
      telemetry_missing: true,
    },
  ];

  await writeJsonl(path.join(root, storeDir, "eval", "ledger.jsonl"), records);
  const scorecard = await readEvalScorecard(path.join(root, storeDir));

  assert.equal(scorecard.telemetry.cycles_total, 2);
  assert.equal(scorecard.telemetry.cycles_with_summary, 1);
  assert.equal(scorecard.telemetry.cycles_missing, 1);
  assert.equal(scorecard.telemetry.tokens_total, 150);
  assert.equal(scorecard.telemetry.tool_calls_total, 1);
  assert.equal(scorecard.telemetry.shell_commands_total, 2);
});
