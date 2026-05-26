import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptPath = path.join(process.cwd(), "scripts", "check-path-hygiene.mjs");

const runCheck = ({ args = [], cwd = process.cwd(), env = process.env } = {}) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });

test("tracked .ato artifacts are path-hygienic", () => {
  const result = runCheck({ args: ["--json"] });
  assert.equal(
    result.status,
    0,
    `expected path hygiene check to pass, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 0);
});

test("path hygiene write mode rewrites inside-repo and external absolute paths", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ato-path-hygiene-"));
  const trackedFile = path.join(repoRoot, ".ato", "queue", "items.jsonl");
  await fs.mkdir(path.dirname(trackedFile), { recursive: true });
  const customTmp = path.join(
    os.homedir(),
    ".ato-test",
    "tmp",
    path.basename(repoRoot),
  );
  await fs.mkdir(customTmp, { recursive: true });

  const init = spawnSync("git", ["init", "--quiet"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr ?? "git init failed");

  const inside = path.join(repoRoot, ".ato", "cycles", "CY-0001", "preflight.json");
  const outside = path.join(customTmp, "outside-proof.log");
  const record = {
    id: "BL-TEST",
    notes: `inside:${inside} outside:${outside}`,
    spec: {
      inputs: [`file:${inside}`, `output:${outside}:12`],
    },
  };
  await fs.writeFile(trackedFile, `${JSON.stringify(record)}\n`, "utf8");

  const add = spawnSync("git", ["add", ".ato/queue/items.jsonl"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr ?? "git add failed");

  const before = runCheck({
    args: ["--root", repoRoot, "--json", "--report-only"],
    cwd: repoRoot,
    env: {
      ...process.env,
      TMPDIR: customTmp,
      TMP: customTmp,
      TEMP: customTmp,
    },
  });
  assert.equal(before.status, 0);
  const beforePayload = JSON.parse(before.stdout);
  assert.equal(beforePayload.ok, false);
  assert.ok(beforePayload.count >= 2);

  const writeMode = runCheck({
    args: ["--root", repoRoot, "--write", "--json"],
    cwd: repoRoot,
    env: {
      ...process.env,
      TMPDIR: customTmp,
      TMP: customTmp,
      TEMP: customTmp,
    },
  });
  assert.equal(
    writeMode.status,
    0,
    `expected write mode to pass, got ${writeMode.status}\n${writeMode.stdout}\n${writeMode.stderr}`,
  );
  const writePayload = JSON.parse(writeMode.stdout);
  assert.equal(writePayload.ok, true);
  assert.equal(writePayload.count, 0);

  const rewrittenRaw = await fs.readFile(trackedFile, "utf8");
  const rewritten = JSON.parse(rewrittenRaw.trim());
  assert.equal(
    rewritten.spec.inputs[0],
    "file:.ato/cycles/CY-0001/preflight.json",
  );
  assert.match(
    rewritten.spec.inputs[1],
    /^output:\$TMPDIR\/(?:.*\/)?outside-proof\.log:12$/,
  );
  assert.match(
    rewritten.notes,
    /inside:\.ato\/cycles\/CY-0001\/preflight\.json outside:\$TMPDIR\/(?:.*\/)?outside-proof\.log/,
  );
});
