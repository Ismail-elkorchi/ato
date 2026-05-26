import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
};

test("npm test targets only test globs", async () => {
  const root = repoRoot();
  const pkgPath = path.join(root, "package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  const script = String(pkg.scripts?.test ?? "");

  assert.match(script, /scripts\/parallel-runner\.mjs/);
  assert.match(script, /test\/\*\.test\.js/);
  assert.match(script, /test\/holdout\/\*\.test\.js/);
  assert.ok(
    !script.includes("src/cli/commands/qa.ts"),
    "npm test should not include src/cli/commands/qa.ts",
  );
});
