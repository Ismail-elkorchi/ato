import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { buildDocsTruthReport } from "../dist/core/docs/truth.js";

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

test("docs truth report is deterministic for valid labeled docs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-docs-truth-ok-"));
  await writeFile(path.join(root, "src", "core", "example.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "test", "example.test.js"), "export {};\n");
  await writeFile(
    path.join(root, "docs", "GUIDE.md"),
    [
      "# Guide",
      "",
      "## Truth Claims",
      "- [implemented] Example behavior is implemented. | evidence: src/core/example.ts, test/example.test.js",
      "- [planned] Extra automation may be added. | evidence: docs/GUIDE.md",
      "- [unknown] External usage is not measured in-repo. | evidence: docs/GUIDE.md",
      "",
    ].join("\n"),
  );

  const first = await buildDocsTruthReport({ root, docs: ["docs/GUIDE.md"] });
  const second = await buildDocsTruthReport({ root, docs: ["docs/GUIDE.md"] });

  assert.equal(first.ok, true);
  assert.equal(first.summary.claims, 3);
  assert.equal(first.summary.implemented, 1);
  assert.equal(first.summary.planned, 1);
  assert.equal(first.summary.unknown, 1);
  assert.equal(first.summary.errors, 0);
  assert.deepEqual(first, second);
});

test("docs truth report flags missing labels and unsupported implemented claims", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-docs-truth-bad-"));
  await writeFile(path.join(root, "docs", "USER_GUIDE.md"), "# placeholder\n");
  await writeFile(
    path.join(root, "docs", "BAD.md"),
    [
      "# Bad Guide",
      "",
      "## Truth Claims",
      "- implemented claim without label markup",
      "- [implemented] Missing code evidence. | evidence: docs/USER_GUIDE.md",
      "",
    ].join("\n"),
  );

  const report = await buildDocsTruthReport({ root, docs: ["docs/BAD.md"] });

  assert.equal(report.ok, false);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has("missing_label"));
  assert.ok(codes.has("implemented_missing_code_evidence"));
});
