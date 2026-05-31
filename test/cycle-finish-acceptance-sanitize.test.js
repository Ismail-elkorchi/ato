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

const writeJsonl = async (filePath, items) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const output = items.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, output.length ? `${output}\n` : "", "utf8");
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
          root: [{ id: "ok", cmd: [process.execPath, "-e", "process.exit(0)"] }],
        },
      },
    },
  });
};

const writeContracts = async (root) => {
  const docPath = path.join(root, ".ato", "contracts", "PLATFORM_CONTRACT.md");
  await fs.mkdir(path.dirname(docPath), { recursive: true });
  await fs.writeFile(docPath, "# PLATFORM\n\n## 0 Purpose\n", "utf8");
  const entryId = "0-purpose-1";
  await writeJson(path.join(root, ".ato", "cache", "contracts.index.json"), {
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
  });
};

const writeBaseline = async (root, tag) => {
  const artifactsDir = path.join(root, ".ato", "runs", "artifacts", "global", "gate");
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, "lint-1.log"), "baseline ok", "utf8");
  const artifactSha = crypto.createHash("sha256").update("baseline ok").digest("hex");

  await fs.writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":1}\n", "utf8");
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

const writeBlock = async (root, baselineTag) => {
  await writeJson(path.join(root, ".ato", "meta", "blocks", "block-0005.json"), {
    version: 1,
    blockId: "block-0005",
    baseline: { tag: baselineTag },
    cyclesPlanned: 1,
    holdout: {
      version: 1,
      tasks: [{ id: "holdout-target-resolve", cmd: [process.execPath, "-e", "process.exit(0)"] }],
    },
  });
};

const writeQueue = async (root, acceptanceChecks) => {
  const item = {
    id: "BL-0001",
    title: "block-0005 queued item",
    type: "tooling",
    status: "queued",
    priority: "P1",
    tags: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    target: { selector: "range", value: "0.1.x" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "seed",
    spec: {
      problem: "p",
      outcome: "o",
      plan: { steps: ["s"] },
      acceptance_criteria: acceptanceChecks,
      inputs: ["output:seed"],
      deliverables: ["d"],
      scope: [],
      risks: [],
      contract_refs: ["§0"],
      runbook: [],
    },
  };
  await writeJsonl(path.join(root, ".ato", "queue", "items.jsonl"), [item]);
};

const initGit = (root, baselineTag) => {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
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
  const tag = spawnSync("git", ["tag", baselineTag], { cwd: root, encoding: "utf8" });
  assert.equal(tag.status, 0, tag.stderr);
};

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
};

test("cycle finish sanitizes absolute paths in acceptance JSON before pack verify", async () => {
  const root = await makeTempDir("ato-acceptance-sanitize-");
  const baselineTag = "baseline-main";
  const check =
    "cmd:node -e \"const path=require('node:path');process.stdout.write(JSON.stringify({agentsPath:path.resolve('AGENTS.md')}));\" -- --json";

  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  await writeBaseline(root, baselineTag);
  await writeBlock(root, baselineTag);
  await writeQueue(root, [check, "cmd:ato cycle finish --json"]);
  initGit(root, baselineTag);

  const start = runCli(root, ["cycle", "start", "--json"]);
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  const cycleId = startPayload.cycle_id;

  const finish = runCli(root, [
    "cycle",
    "finish",
    "--json",
    "--run-acceptance",
    "--run-gate",
    "--run-pack-verify",
    "--budget-ms",
    "600000",
  ]);
  assert.equal(finish.status, 0, finish.stderr);
  const finishPayload = JSON.parse(finish.stdout.trim());
  assert.equal(finishPayload.ok, true);
  assert.equal(finishPayload.pack_verify_ref?.ok, true);

  const artifact = path.join(root, ".ato", "cycles", cycleId, "acceptance-01.json");
  const parsed = JSON.parse(await fs.readFile(artifact, "utf8"));
  const value = String(parsed.agentsPath ?? "");
  assert.ok(value.length > 0);
  assert.equal(path.isAbsolute(value), false);
  assert.ok(!/\/home\//.test(value));
});
