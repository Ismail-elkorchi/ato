import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createAjv } from "../dist/core/schemas/ajv.js";

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const loadSchema = async (name) => {
  const schemaPath = path.resolve("dist", "core", "schemas", name);
  const raw = await fs.readFile(schemaPath, "utf8");
  return JSON.parse(raw);
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
  });
};

const initGit = (root) => {
  const result = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

const runJsonCommand = (root, args) => {
  const cliPath = path.resolve("dist/cli/main.js");
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};

test("git status json output satisfies git-status.v2 schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-status-schema-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);

    const payload = runJsonCommand(root, ["git", "status"]);
    assert.equal(payload.schema_version, "git-status.v2");

    const schema = await loadSchema("git-status.v2.json");
    const ajv = createAjv({ allErrors: true });
    const validate = ajv.compile(schema);
    assert.equal(validate(payload), true, JSON.stringify(validate.errors, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("git locks json output satisfies git-locks.v1 schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-git-locks-schema-"));
  try {
    initGit(root);
    await writeAgents(root);
    await writeConfig(root);

    const payload = runJsonCommand(root, ["git", "locks"]);
    assert.equal(payload.schema_version, "git-locks.v1");

    const schema = await loadSchema("git-locks.v1.json");
    const ajv = createAjv({ allErrors: true });
    const validate = ajv.compile(schema);
    assert.equal(validate(payload), true, JSON.stringify(validate.errors, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
