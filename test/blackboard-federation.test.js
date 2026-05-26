import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createAjv } from "../dist/core/schemas/ajv.js";

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

const writeConfig = async (root, seed) => {
  const config = {
    version: 1,
    targetId: "tmp",
    storeDir: ".ato",
    fingerprintSeed: seed,
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
  await writeJson(path.join(root, ".ato", "signals", "definitions.json"), [
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
};

const runCli = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  return spawnSync(process.execPath, [cliPath, "--repo", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
};

const loadSchema = async (name) => {
  const schemaPath = path.resolve("dist/core/schemas", name);
  const raw = await fs.readFile(schemaPath, "utf8");
  return JSON.parse(raw);
};

const spawnCli = (root, args) =>
  new Promise((resolve) => {
    const cliPath = path.resolve("dist/cli/main.js");
    const child = spawn(process.execPath, [cliPath, "--repo", root, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });

const hashFile = async (filePath) => {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
};

const assertNoAbsolutePaths = (value, root) => {
  const normalizedRoot = root.replace(/\\/g, "/");
  const normalizedValue = value.replace(/\\/g, "/");
  assert.ok(!normalizedValue.includes(normalizedRoot));
  assert.ok(!/\/home\/|[A-Z]:\\/.test(normalizedValue));
};

const listStoreFiles = async (root) => {
  const storeRoot = path.join(root, ".ato");
  const results = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(
          path.relative(storeRoot, fullPath).replace(/\\/g, "/"),
        );
      }
    }
  };
  await walk(storeRoot);
  results.sort();
  return results;
};

const writeQueue = async (root) => {
  const queuePath = path.join(root, ".ato", "queue", "items.jsonl");
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, "{\"id\":\"BL-0001\"}\n", "utf8");
  return queuePath;
};

test("bb export writes deterministic export with repo-relative path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-export-"));
  await writeAgents(root);
  await writeConfig(root, "bb-export-seed");
  await writeCatalog(root);
  const queuePath = await writeQueue(root);
  const before = await hashFile(queuePath);

  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  await fs.mkdir(inboxDir, { recursive: true });
  const postA = {
    schema_version: "bb-post.v1",
    id: "20240102T000000000Z__b",
    created_at: "2024-01-02T00:00:00.000Z",
    kind: "note",
    author: "tester",
    scope: { block_id: "block-0008" },
    text: "later",
    trust: "untrusted",
  };
  const postB = {
    schema_version: "bb-post.v1",
    id: "20240101T000000000Z__a",
    created_at: "2024-01-01T00:00:00.000Z",
    kind: "note",
    author: "tester",
    scope: { block_id: "block-0008" },
    text: "earlier",
    trust: "untrusted",
  };
  await fs.writeFile(
    path.join(inboxDir, `${postA.id}.json`),
    `${JSON.stringify(postA)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(inboxDir, `${postB.id}.json`),
    `${JSON.stringify(postB)}\n`,
    "utf8",
  );

  const result = runCli(root, [
    "bb",
    "export",
    "--out",
    ".ato/blackboard/export.json",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema_version, "bb-export.v1");
  assert.equal(payload.path, ".ato/blackboard/export.json");
  assert.equal(payload.post_count, 2);
  assert.equal(typeof payload.origin?.repo_fingerprint, "string");
  assert.ok(payload.origin.repo_fingerprint.length > 0);

  const exportPath = path.join(root, ".ato", "blackboard", "export.json");
  const exportContent = await fs.readFile(exportPath, "utf8");
  const exportPayload = JSON.parse(exportContent);
  assert.equal(exportPayload.schema_version, "bb-export.v1");
  assert.equal(
    exportPayload.origin?.repo_fingerprint,
    payload.origin.repo_fingerprint,
  );
  const schema = await loadSchema("bb-export.v1.json");
  const ajv = createAjv();
  const validate = ajv.compile(schema);
  assert.equal(
    validate(exportPayload),
    true,
    JSON.stringify(validate.errors, null, 2),
  );
  const postIds = exportPayload.posts.map((post) => post.id);
  assert.deepEqual(postIds, [postB.id, postA.id]);

  const repeat = runCli(root, [
    "bb",
    "export",
    "--out",
    ".ato/blackboard/export-repeat.json",
    "--json",
  ]);
  assert.equal(repeat.status, 0, repeat.stderr);
  const repeatPath = path.join(
    root,
    ".ato",
    "blackboard",
    "export-repeat.json",
  );
  const repeatContent = await fs.readFile(repeatPath, "utf8");
  assert.equal(repeatContent, exportContent);
  assertNoAbsolutePaths(exportContent, root);

  const after = await hashFile(queuePath);
  assert.equal(after, before);
});

test("bb import requires allow-external and does not mutate queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-import-"));
  await writeAgents(root);
  await writeConfig(root, "bb-import-seed");
  await writeCatalog(root);

  const queuePath = await writeQueue(root);
  const before = await hashFile(queuePath);

  const exportPayload = {
    schema_version: "bb-export.v1",
    exported_at: "2026-01-01T00:00:00.000Z",
    origin: {
      repo_id: "remote",
      repo_fingerprint: "feedface",
    },
    posts: [
      {
        schema_version: "bb-post.v1",
        id: "20240101T000000000Z__a",
        created_at: "2024-01-01T00:00:00.000Z",
        kind: "note",
        author: "tester",
        scope: { block_id: "block-0008" },
        text: "hello",
        trust: "untrusted",
      },
      {
        schema_version: "bb-post.v1",
        id: "20240102T000000000Z__b",
        created_at: "2024-01-02T00:00:00.000Z",
        kind: "question",
        author: "tester",
        scope: { block_id: "block-0008" },
        text: "hi",
        trust: "untrusted",
      },
    ],
  };

  const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-export-"));
  const exportPath = path.join(exportDir, "export.json");
  await fs.writeFile(exportPath, `${JSON.stringify(exportPayload)}\n`, "utf8");
  const filesBefore = await listStoreFiles(root);

  const rejected = runCli(root, [
    "bb",
    "import",
    "--from",
    exportPath,
    "--json",
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /allow-external/);
  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  await assert.rejects(fs.stat(inboxDir));

  const result = runCli(root, [
    "bb",
    "import",
    "--from",
    exportPath,
    "--allow-external",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema_version, "bb-import.v1");
  assert.equal(payload.imported, 2);
  const entries = await fs.readdir(inboxDir);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((name) => name.startsWith("import__")));

  const inboxPayloads = await Promise.all(
    entries.map(async (name) =>
      JSON.parse(
        await fs.readFile(path.join(inboxDir, name), "utf8"),
      ),
    ),
  );
  for (const post of inboxPayloads) {
    assert.equal(post.trust, "untrusted");
    assert.equal(post.origin?.repo_fingerprint, "feedface");
  }

  const firstShow = runCli(root, ["bb", "show", "--json"]);
  assert.equal(firstShow.status, 0, firstShow.stderr);
  const showPayload = JSON.parse(firstShow.stdout);
  const showIds = (showPayload.posts ?? []).map((post) => post.id);
  const sortedIds = [...showIds].sort();
  assert.deepEqual(showIds, sortedIds);

  const filesAfter = await listStoreFiles(root);
  const beforeSet = new Set(filesBefore);
  const added = filesAfter.filter((file) => !beforeSet.has(file));
  assert.ok(added.length > 0);
  for (const file of added) {
    assert.ok(file.startsWith("blackboard/"));
  }

  const after = await hashFile(queuePath);
  assert.equal(after, before);
});

test("bb post supports concurrent writers and does not mutate queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-concurrent-"));
  await writeAgents(root);
  await writeConfig(root, "bb-concurrent-seed");
  await writeCatalog(root);
  await writeJson(path.join(root, ".ato", "lock.json"), {
    pid: 123,
    startedAt: "2025-01-01T00:00:00.000Z",
  });

  const queuePath = await writeQueue(root);
  const before = await hashFile(queuePath);

  const writerCount = 2;
  const writers = Array.from({ length: writerCount }).map((_, index) =>
    spawnCli(root, [
      "bb",
      "post",
      "--kind",
      "note",
      "--text",
      `msg-${index}`,
      "--block-id",
      "block-0008",
      "--json",
    ]),
  );
  const results = await Promise.all(writers);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }

  const inboxDir = path.join(root, ".ato", "blackboard", "inbox");
  const entries = await fs.readdir(inboxDir);
  assert.equal(entries.length, writerCount);

  const first = runCli(root, ["bb", "show", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(root, ["bb", "show", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);

  const after = await hashFile(queuePath);
  assert.equal(after, before);
});

test("bb export/post/show never mutates queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-bb-queue-"));
  await writeAgents(root);
  await writeConfig(root, "bb-queue-seed");
  await writeCatalog(root);

  const queuePath = await writeQueue(root);
  const before = await hashFile(queuePath);

  const post = runCli(root, [
    "bb",
    "post",
    "--kind",
    "note",
    "--text",
    "queue-check",
    "--block-id",
    "block-0009",
    "--json",
  ]);
  assert.equal(post.status, 0, post.stderr);

  const exportResult = runCli(root, [
    "bb",
    "export",
    "--out",
    ".ato/blackboard/export.json",
    "--json",
  ]);
  assert.equal(exportResult.status, 0, exportResult.stderr);

  const showResult = runCli(root, ["bb", "show", "--json"]);
  assert.equal(showResult.status, 0, showResult.stderr);

  const after = await hashFile(queuePath);
  assert.equal(after, before);
});
