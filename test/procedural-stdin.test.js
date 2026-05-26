import { test } from "node:test";
import assert from "node:assert/strict";

import { runProceduralEntry } from "../dist/core/memory/procedural.js";

const script =
  "let data='';process.stdin.on('data',c=>data+=c);" +
  "process.stdin.on('end',()=>{process.exit(data==='hello'?0:2);});";
const cmd = `node -e "${script}"`;

test("runProceduralEntry pipes recorded stdin", async () => {
  const entry = {
    id: "procedural-2025-01-01T00-00-00-000Z",
    version: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    commands: [
      {
        cmd,
        input: "hello",
      },
    ],
  };
  const result = await runProceduralEntry({ root: process.cwd(), entry });
  assert.equal(result.ok, true);
  assert.equal(result.commands[0]?.exitCode, 0);
});

test("runProceduralEntry errors when stdin is required but missing", async () => {
  const entry = {
    id: "procedural-2025-01-01T00-00-00-001Z",
    version: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    commands: [
      {
        cmd,
        stdinRequired: true,
      },
    ],
  };
  await assert.rejects(
    () => runProceduralEntry({ root: process.cwd(), entry }),
    /requires stdin input/,
  );
});
