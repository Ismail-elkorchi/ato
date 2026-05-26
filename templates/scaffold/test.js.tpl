import { test } from "node:test";
import assert from "node:assert/strict";

import { {{camelName}} } from "../dist/core/{{slug}}/index.js";

test("{{slug}} scaffold", () => {
  const value = {{camelName}}({ name: "{{name}}" });
  assert.equal(value, "{{name}}");
});
