import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import Ajv from "ajv/dist/2020.js";

const loadSchema = async (name) => {
  const schemaUrl = new URL(`../dist/core/schemas/${name}`, import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

test("status schema validates sample payloads", async () => {
  const statusSchema = await loadSchema("status.v2.json");

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(statusSchema);

  const statusPayload = {
    ok: true,
    schema_version: "status.v2",
    active_cycle: null,
    selected_queue_id: null,
    next_action: "ato cycle start --json",
    next_action_state: "ready_to_start",
    next_action_reason: "ready_for_cycle_start",
    next_action_source: "status-transition-registry.v1",
    dirty_tree: false,
    dirty_paths: [],
    git_plan_suggestions: [],
    agent_instructions: [],
  };

  const validations = [{ schema: statusSchema, data: statusPayload }];

  for (const entry of validations) {
    const validate = ajv.compile(entry.schema);
    assert.equal(validate(entry.data), true, JSON.stringify(validate.errors, null, 2));
  }
});
