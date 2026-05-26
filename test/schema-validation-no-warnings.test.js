import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createAjv } from "../dist/core/schemas/ajv.js";

const loadSchemas = async () => {
  const dir = path.resolve("dist/core/schemas");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const schemas = [];
  for (const name of files) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    schemas.push({ name, schema: JSON.parse(raw) });
  }
  return schemas;
};

test("schema compilation emits no warnings", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const ajv = createAjv();
    const schemas = await loadSchemas();
    for (const entry of schemas) {
      const schemaId =
        entry.schema && typeof entry.schema.$id === "string"
          ? entry.schema.$id
          : null;
      assert.doesNotThrow(
        () =>
          schemaId
            ? ajv.addSchema(entry.schema)
            : ajv.addSchema(entry.schema, entry.name),
        entry.name,
      );
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(
    warnings,
    [],
    `Unexpected schema warnings:\n${warnings.join("\n")}`,
  );
});
