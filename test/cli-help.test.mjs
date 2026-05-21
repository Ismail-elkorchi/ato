import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../dist/cli/main.js";

function createIo(cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
      cwd: () => cwd,
    },
    output: () => ({ stdout, stderr }),
  };
}

test("prints help", () => {
  const { io, output } = createIo();

  const exitCode = run(["--help"], io);

  assert.equal(exitCode, 0);
  assert.match(output().stdout, /Usage:/);
  assert.equal(output().stderr, "");
});

test("prints version", () => {
  const { io, output } = createIo();

  const exitCode = run(["--version"], io);

  assert.equal(exitCode, 0);
  assert.equal(output().stdout, "0.0.0\n");
  assert.equal(output().stderr, "");
});

test("rejects unknown commands", () => {
  const { io, output } = createIo();

  const exitCode = run(["unknown"], io);

  assert.equal(exitCode, 2);
  assert.match(output().stderr, /Unknown command/);
});
