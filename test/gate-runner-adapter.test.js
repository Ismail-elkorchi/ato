import { test } from "node:test";
import assert from "node:assert/strict";

import { runGateSelection } from "../dist/core/gates/runner.js";

test("gate runner routes step execution through adapter", async () => {
  const calls = [];
  const adapter = {
    id: "node",
    label: "Node",
    status: "enabled",
    executeStep: async (input) => {
      calls.push(input);
      return {
        ok: true,
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        commandLine: input.cmd.join(" "),
        artifactPath: null,
      };
    },
  };

  const plan = { mode: "manual", reason: "test", scopes: [], gates: [] };
  const gates = [{ id: "adapter-test", cmd: ["echo", "ok"] }];

  const result = await runGateSelection({
    root: process.cwd(),
    targetId: "test",
    queueId: null,
    mode: "fast",
    plan,
    gates,
    artifactsDir: null,
    adapter,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd[0], "echo");
  assert.equal(result.results[0]?.command, "echo ok");
});
