import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const parseConcurrency = () => {
  const raw = process.env.ATO_TEST_CONCURRENCY;
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto") return null;
  const value = Number(normalized);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const writeProbeTests = async ({
  root,
  count,
  resultsPath,
  barrierDir,
  intervalMs,
  maxAttempts,
}) => {
  const testDir = path.join(root, "test");
  await fs.mkdir(testDir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const filePath = path.join(testDir, `parallelism-probe-${i}.test.js`);
    const content = [
      'import { test } from "node:test";',
      'import { promises as fs } from "node:fs";',
      'import path from "node:path";',
      'import { setTimeout as delay } from "node:timers/promises";',
      'import { fileURLToPath } from "node:url";',
      `const resultsPath = ${JSON.stringify(resultsPath)};`,
      `const barrierDir = ${JSON.stringify(barrierDir)};`,
      `const intervalMs = ${intervalMs};`,
      `const maxAttempts = ${maxAttempts};`,
      `const probeId = ${JSON.stringify(`probe-${i}`)};`,
      "const receiptsPath = process.env.ATO_RUNNER_RECEIPTS_PATH;",
      "if (!receiptsPath) {",
      "  throw new Error(\"ATO_RUNNER_RECEIPTS_PATH missing\");",
      "}",
      "const testFileRel = path",
      "  .relative(process.cwd(), fileURLToPath(import.meta.url))",
      "  .replace(/\\\\/g, \"/\");",
      'const append = async (payload) => {',
      '  await fs.appendFile(resultsPath, `${JSON.stringify(payload)}\\n`, "utf8");',
      "};",
      "const readyPath = path.join(barrierDir, `${probeId}.ready.json`);",
      "const releasePath = path.join(barrierDir, \"release.json\");",
      'test(`parallelism probe ${probeId}`, async () => {',
      "  const receiptsRaw = await fs.readFile(receiptsPath, \"utf8\");",
      "  const receipt = receiptsRaw",
      "    .split(/\\r?\\n/)",
      "    .filter(Boolean)",
      "    .map((line) => JSON.parse(line))",
      "    .find((entry) => entry.test_file === testFileRel);",
      "  if (!receipt) {",
      "    throw new Error(`Missing receipt for ${testFileRel}`);",
      "  }",
      "  await fs.mkdir(barrierDir, { recursive: true });",
      "  await fs.writeFile(",
      "    readyPath,",
      "    JSON.stringify({",
      "      id: probeId,",
      "      test_file: testFileRel,",
      "      receipt_hash: receipt.receipt_hash,",
      "    }),",
      "    \"utf8\",",
      "  );",
      "  await append({",
      "    id: probeId,",
      "    test_file: testFileRel,",
      "    receipt_hash: receipt.receipt_hash,",
      "    phase: \"ready\",",
      "  });",
      "  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {",
      "    const readyFiles = await fs.readdir(barrierDir);",
      "    const readyCount = readyFiles.filter((f) => f.endsWith(\".ready.json\")).length;",
      "    if (readyCount >= 2) {",
      "      if (!(await fs.stat(releasePath).catch(() => null))) {",
      "        await fs.writeFile(releasePath, JSON.stringify({ ok: true }), \"utf8\");",
      "      }",
      "      await append({",
      "        id: probeId,",
      "        test_file: testFileRel,",
      "        receipt_hash: receipt.receipt_hash,",
      "        phase: \"release\",",
      "      });",
      "      return;",
      "    }",
      "    await delay(intervalMs);",
      "  }",
      "  await append({",
      "    id: probeId,",
      "    test_file: testFileRel,",
      "    receipt_hash: receipt.receipt_hash,",
      "    phase: \"timeout\",",
      "  });",
      "});",
      "",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf8");
    files.push(path.relative(root, filePath).replace(/\\/g, "/"));
  }
  return files;
};

const collectPhases = (lines) => {
  const phases = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry.receipt_hash || !entry.test_file) {
      throw new Error("Receipt hash or test_file missing in markers.");
    }
    const current = phases.get(entry.id) ?? [];
    current.push(entry.phase);
    phases.set(entry.id, current);
  }
  return phases;
};

const concurrency = parseConcurrency();

test(
  "parallel runner yields overlap when concurrency > 1",
  { skip: concurrency ? undefined : "ATO_TEST_CONCURRENCY not set" },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ato-parallel-proof-"),
    );
    try {
      const resultsPath = path.join(root, "results.jsonl");
      const barrierDir = path.join(root, "barrier");
      const probeFiles = await writeProbeTests({
        root,
        count: 2,
        resultsPath,
        barrierDir,
        intervalMs: 50,
        maxAttempts: 20,
      });
      await fs.writeFile(resultsPath, "", "utf8");
      const runnerPath = path.resolve("scripts/parallel-runner.mjs");
      const args = [runnerPath, ...probeFiles];
      const childEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith("NODE_TEST_CONTEXT")) {
          delete childEnv[key];
        }
      }
      childEnv.ATO_TEST_CONCURRENCY = String(concurrency);
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env: childEnv,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const [headerLine] = result.stdout.split(/\r?\n/);
      assert.ok(headerLine);
      const header = JSON.parse(headerLine);
      const receiptsPath = path.join(
        root,
        ...String(header.receipts_path).split("/"),
      );
      const receiptsRaw = await fs.readFile(receiptsPath, "utf8");
      const receipts = receiptsRaw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const receiptHashes = new Set(receipts.map((entry) => entry.receipt_hash));
      const lines = (await fs.readFile(resultsPath, "utf8")).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        assert.ok(receiptHashes.has(entry.receipt_hash));
      }
      const phases = collectPhases(lines);
      assert.equal(
        phases.size,
        2,
        result.stderr || result.stdout || "missing probe phases",
      );
      const phaseLists = [...phases.values()];
      const timeouts = phaseLists.filter((list) => list.includes("timeout"));
      const releases = phaseLists.filter((list) => list.includes("release"));
      if (concurrency === 1) {
        assert.equal(timeouts.length, 1);
        assert.equal(releases.length, 1);
      } else {
        assert.equal(timeouts.length, 0);
        assert.equal(releases.length, 2);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
