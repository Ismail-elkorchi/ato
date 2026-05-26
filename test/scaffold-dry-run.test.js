import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scaffoldFromSpec } from "../dist/core/scaffold/index.js";

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

test("scaffoldFromSpec dry-run returns plan without writing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-scaffold-"));
  const templatesRoot = path.join(root, "templates", "scaffold");
  await writeFile(path.join(templatesRoot, "command.ts.tpl"), "command {{name}}");
  await writeFile(path.join(templatesRoot, "core.ts.tpl"), "core {{name}}");
  await writeFile(path.join(templatesRoot, "test.js.tpl"), "test {{name}}");
  await writeFile(path.join(templatesRoot, "doc.md.tpl"), "doc {{name}}");

  const result = await scaffoldFromSpec({
    root,
    templatesRoot,
    dryRun: true,
    spec: {
      name: "Example",
      summary: "Example summary",
      description: "Example description",
      usage: "Example usage",
    },
  });

  assert.equal(result.outputs.length, 4);
  assert.equal(result.plan.length, 4);
  assert.ok(result.plan[0]?.template.includes("templates/scaffold"));

  const expected = [
    "src/cli/commands/example.ts",
    "src/core/example/index.ts",
    "test/example.test.js",
    "docs/example.md",
  ];
  for (const rel of expected) {
    await assert.rejects(() => fs.stat(path.join(root, rel)));
  }
});
