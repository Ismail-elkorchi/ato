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

test("scaffoldFromSpec rejects missing summary/description/usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-scaffold-req-"));
  const templatesRoot = path.join(root, "templates", "scaffold");
  await writeFile(path.join(templatesRoot, "command.ts.tpl"), "command {{name}}");
  await writeFile(path.join(templatesRoot, "core.ts.tpl"), "core {{name}}");
  await writeFile(path.join(templatesRoot, "test.js.tpl"), "test {{name}}");
  await writeFile(path.join(templatesRoot, "doc.md.tpl"), "doc {{name}}");

  await assert.rejects(
    () =>
      scaffoldFromSpec({
        root,
        templatesRoot,
        dryRun: true,
        spec: { name: "Example" },
      }),
    (error) => {
      const err = error;
      return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === 3
      );
    },
  );
});
