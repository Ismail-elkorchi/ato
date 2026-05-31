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
  const artifactsDir = path.join(
    root,
    ".ato",
    "runs",
    "artifacts",
    "global",
    "gate",
  );
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactPath = path.join(artifactsDir, "lint-1.log");
  await fs.writeFile(artifactPath, "baseline ok", "utf8");
  const artifactSha = crypto
    .createHash("sha256")
    .update("baseline ok")
    .digest("hex");

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

const writeQueue = async (root) => {
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
    notes: "Completed. Evidence: output:seed",
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
      inputs: ["output:seed"],
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

const hashFile = async (filePath) => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

test("cycle finish produces evidence pack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-cycle-pack-"));
  initGit(root);
  await writeAgents(root);
  await writeConfig(root);
  await writeContracts(root);
  const baselineTag = "baseline-test";
  await writeBaseline(root, { tag: baselineTag });
  await writeBlock(root, { baselineTag });
  await writeQueue(root);
  commitAll(root);
  tagBaseline(root, baselineTag);

  const cliPath = path.resolve("dist/cli/main.js");
  const env = { ...process.env };
  const start = spawnSync(
    process.execPath,
    [cliPath, "cycle", "start", "--json"],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(start.status, 0, start.stderr);
  const startPayload = JSON.parse(start.stdout.trim());
  const cycleId = startPayload.cycle_id;

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
  assert.equal(finish.status, 0, finish.stderr);

  const cycleFinishPath = path.join(
    root,
    ".ato",
    "cycles",
    cycleId,
    "cycle-finish.json",
  );
  const cycleFinish = JSON.parse(await fs.readFile(cycleFinishPath, "utf8"));
  const packRef = cycleFinish.pack_ref;
  assert.equal(packRef.kind, "cycle_pack");
  assert.equal(packRef.cycle_id, cycleId);
  assert.equal(path.isAbsolute(packRef.path), false);
  assert.equal(path.isAbsolute(packRef.manifest_path), false);
  const packVerifyRef = cycleFinish.pack_verify_ref;
  assert.equal(packVerifyRef.kind, "pack_verify");
  assert.equal(packVerifyRef.cycle_id, cycleId);
  assert.equal(path.isAbsolute(packVerifyRef.path), false);

  const packPath = path.join(root, packRef.path);
  const manifestPath = path.join(root, packRef.manifest_path);
  const packSha = await hashFile(packPath);
  assert.equal(packSha, packRef.sha256);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.cycle_id, cycleId);
  assert.equal(manifest.pack_path, packRef.path);
  assert.equal(manifest.pack_sha256, packRef.sha256);
  assert.ok(Array.isArray(manifest.entries));
  assert.ok(manifest.entries.length > 0);

  const packVerifyPath = path.join(root, packVerifyRef.path);
  const packVerifySha = await hashFile(packVerifyPath);
  assert.equal(packVerifySha, packVerifyRef.sha256);
  const packVerify = JSON.parse(await fs.readFile(packVerifyPath, "utf8"));
  assert.equal(packVerify.ok, true);
});
