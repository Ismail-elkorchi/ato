import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const resolveTempBase = (repoRoot) => {
  const tmpRoot = os.tmpdir();
  const rel = path.relative(repoRoot, tmpRoot);
  const isInside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isInside) return tmpRoot;
  return path.join(path.dirname(repoRoot), ".ato-test-tmp");
};

const makeTempDir = async (prefix) => {
  const repoRoot = path.resolve(".");
  const base = resolveTempBase(repoRoot);
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, prefix));
};

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
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
    contracts: { platform: ".ato/contracts/PLATFORM_CONTRACT.md" },
    gates: {
      fast: [],
      full: {
        tests: {
          order: ["root"],
          root: [
            { id: "ok", cmd: [process.execPath, "-e", "process.exit(0)"] },
          ],
        },
      },
    },
  });
};

const writeContracts = async (root) => {
  const docPath = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await fs.mkdir(path.dirname(docPath), { recursive: true });
  await fs.writeFile(docPath, "# PLATFORM\n\n## 0 Purpose\n", "utf8");
  const indexPath = path.join(root, ".ato", "cache", "contracts.index.json");
  const entryId = "0-purpose-1";
  const index = {
    version: 1,
    generated_at: "2025-01-01T00:00:00.000Z",
    docs: [
      {
        doc: docPath,
        entries: [
          {
            id: entryId,
            heading: "0 Purpose",
            path: "PLATFORM_CONTRACT / 0 Purpose",
            anchor: "0-purpose",
            sectionNumber: "0",
            aliases: ["§0", "0"],
            level: 2,
            lineStart: 1,
            lineEnd: 2,
          },
        ],
      },
    ],
    lookup: {
      [`${docPath}::§0`]: { doc: docPath, entryId },
      [`${docPath}::0`]: { doc: docPath, entryId },
    },
  };
  await writeJson(indexPath, index);
};

const writeBlock = async (root, { baselineTag }) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), {
    version: 1,
    blockId: "block-0005",
    baseline: { tag: baselineTag },
    rules: {
      controlGroup: {
        enabled: true,
        cadenceEveryNCycles: 5,
        selection: "random_from_evidence_pool",
        determinism: { seedSource: "blockId" },
      },
    },
    holdout: {
      version: 1,
      tasks: [
        {
          id: "holdout-target-resolve",
          cmd: [process.execPath, "-e", "process.exit(0)"],
        },
      ],
    },
  });
};

const writeBaseline = async (root, { tag }) => {
  const artifactsDir = path.join(root, ".ato", "runs", "artifacts", "global", "gate");
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactPath = path.join(artifactsDir, "lint-1.log");
  await fs.writeFile(artifactPath, "baseline ok", "utf8");
  const artifactSha = crypto.createHash("sha256").update("baseline ok").digest("hex");

  const lockfilePath = path.join(root, "package-lock.json");
  await fs.writeFile(lockfilePath, "{\"lockfileVersion\":1}\n", "utf8");
  const lockSha = crypto
    .createHash("sha256")
    .update("{\"lockfileVersion\":1}\n")
    .digest("hex");

  await writeJson(path.join(root, ".ato", "meta", "baselines", `${tag}.json`), {
    schema_version: "baseline-registry.v1",
    tag,
    gate_profile: { id: "config-default", version: 1 },
    gate_command: "node dist/cli/main.js gate run --mode full --json",
    artifacts: [
      {
        path: ".ato/runs/artifacts/global/gate/lint-1.log",
        sha256: artifactSha,
      },
    ],
    env: {
      node: "v20.0.0",
      npm: "0.0.0",
      platform: "test",
      lockfile: { path: "package-lock.json", sha256: lockSha },
    },
  });
};

const tagBaseline = (root, tag) => {
  const result = spawnSync("git", ["tag", tag], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

const writeQueue = async (root, { notes, inputs }) => {
  const item = {
    id: "BL-0001",
    title: "Block-0005 queued item",
    type: "tooling",
    status: "queued",
    priority: "P2",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes,
    spec: {
      problem: "problem",
      outcome: "outcome",
      plan: {
        steps: ["step"],
      },
      acceptance_criteria: [
        "cmd:node -e process.exit(0)",
        "cmd:ato gate run --mode full --json",
        "cmd:ato cycle finish --json",
      ],
      inputs,
      deliverables: ["deliverable"],
      scope: [],
      risks: [],
      contract_refs: ["§0"],
      runbook: [],
    },
  };
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [item]);
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

const readQueueItem = async (root) => {
  const raw = await fs.readFile(path.join(root, ".ato", "queue", "items.jsonl"), "utf8");
  const lines = raw.trim().split(/\r?\n/);
  return JSON.parse(lines[0]);
};

const runCycleStartFinish = (root) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };
  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  const finish = spawnSync(
    process.execPath,
    [
      cliPath,
      "cycle",
      "finish",
      "--json",
      "--run-acceptance",
      "--run-gate",
      "--run-pack-verify",
    ],
    { cwd: root, encoding: "utf8", env },
  );
  return { startPayload, finish };
};

const runCycleStart = (root) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env, ATO_TEST_SHARD: "" };
  return spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
};

test("cycle finish auto-adds evidence note when summary missing", async () => {
  const root = await makeTempDir("ato-cycle-finish-note-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-auto-note";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root, { notes: "", inputs: ["output:seed"] });
  commitAll(root);
  tagBaseline(root, baselineTag);

  const { startPayload, finish } = runCycleStartFinish(root);
  assert.equal(finish.status, 0, finish.stderr);

  const item = await readQueueItem(root);
  assert.equal(item.status, "done");
  assert.ok(
    typeof item.notes === "string" &&
      item.notes.includes("Completed in cycle") &&
      item.notes.includes("Evidence:"),
  );

  const lines = item.notes.split(/\r?\n/);
  const completionLines = lines.filter((line) =>
    line.startsWith("Completed in cycle"),
  );
  assert.equal(completionLines.length, 1);
  const evidenceLine = completionLines[0];
  assert.ok(evidenceLine);
  const refs = evidenceLine
    .replace(/^Completed in cycle\s+\S+\.\s+Evidence:\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(refs.length > 0);
  const sorted = [...refs].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(refs, sorted);
  assert.equal(new Set(refs).size, refs.length);

  const autoNotePath = path.join(
    root,
    ".ato",
    "cycles",
    startPayload.cycle_id,
    "auto-evidence-note.json",
  );
  const autoNote = JSON.parse(await fs.readFile(autoNotePath, "utf8"));
  assert.equal(autoNote.ok, true);
  assert.equal(autoNote.cycle_id, startPayload.cycle_id);
});

test("cycle finish error payload distinguishes missing inputs", async () => {
  const root = await makeTempDir("ato-cycle-finish-missing-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-missing";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root, { notes: "", inputs: ["file:.env"] });
  commitAll(root);
  tagBaseline(root, baselineTag);

  const { finish } = runCycleStartFinish(root);
  assert.notEqual(finish.status, 0);
  const payload = JSON.parse(finish.stdout.trim());
  assert.equal(payload.ok, false);
  const missingPaths = payload.error?.details?.missing_input_paths ?? [];
  assert.ok(missingPaths.includes("/spec/inputs/0"));
  const templates = payload.error?.details?.template ?? [];
  const hasInputsTemplate = templates.some(
    (entry) => Array.isArray(entry?.spec?.inputs),
  );
  assert.equal(hasInputsTemplate, true);
});

test("cycle finish accepts dotfile file citations in inputs", async () => {
  const root = await makeTempDir("ato-cycle-finish-dotfile-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-dotfile";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root, {
    notes: "Cycle summary. Evidence: output:seed",
    inputs: ["file:.gitignore"],
  });
  commitAll(root);
  tagBaseline(root, baselineTag);

  const { finish } = runCycleStartFinish(root);
  assert.equal(finish.status, 0, finish.stderr);
});

test("cycle start rejects absolute file citations in inputs", async () => {
  const root = await makeTempDir("ato-cycle-finish-abs-file-");
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-abs-file";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  const absPath = path.join(root, ".gitignore");
  await writeQueue(root, {
    notes: "Cycle summary. Evidence: output:seed",
    inputs: [`file:${absPath}`],
  });
  commitAll(root);
  tagBaseline(root, baselineTag);

  const start = runCycleStart(root);
  assert.notEqual(start.status, 0);
  const payload = JSON.parse(start.stdout.trim());
  assert.equal(payload.ok, false);
  const errors = payload.error?.details?.errors ?? [];
  const text = JSON.stringify(errors);
  assert.ok(text.includes("/spec/inputs/0"), text);
  assert.ok(text.includes("absolute paths are not allowed"), text);
});
