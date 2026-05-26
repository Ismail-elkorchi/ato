import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildComplianceReport } from "../dist/core/contracts/compliance.js";
import { buildDocDeltaReport } from "../dist/core/docs/index.js";

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

const makeCapability = ({ id, command, subcommand }) => ({
  id,
  command,
  subcommand,
  summary: "test capability",
  flags: [],
  target: { required: false, write: false },
  sideEffects: { read: true, write: false, network: false },
  preconditions: [],
});

test("docs delta reports missing commands from required docs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-docs-delta-"));
  const manifestPath = path.join(root, "src", "core", "capability", "manifest.ts");
  const readmePath = path.join(root, "README.md");
  const userGuidePath = path.join(root, "docs", "USER_GUIDE.md");

  await writeFile(
    manifestPath,
    [
      "export const CAPABILITIES = [",
      '  { id: "alpha.one" },',
      '  { id: "beta.two" },',
      "];",
      "",
    ].join("\n"),
  );
  await writeFile(readmePath, "# Test\n\n- `ato alpha one`\n", "utf8");
  await writeFile(userGuidePath, "- `ato alpha one`\n", "utf8");

  const capabilities = [
    makeCapability({ id: "alpha.one", command: "alpha", subcommand: "one" }),
    makeCapability({ id: "beta.two", command: "beta", subcommand: "two" }),
  ];

  const report = await buildComplianceReport({
    root,
    manifestPath,
    capabilities,
    docs: [
      { path: readmePath, required: true },
      { path: userGuidePath, required: true },
    ],
  });
  const delta = buildDocDeltaReport(report);

  const byPath = new Map(delta.files.map((entry) => [entry.path, entry.missing]));
  const readmeMissing = byPath.get("README.md") ?? [];
  const guideMissing = byPath.get("docs/USER_GUIDE.md") ?? [];

  assert.ok(readmeMissing.some((entry) => entry.id === "beta.two"));
  assert.ok(guideMissing.some((entry) => entry.id === "beta.two"));
});
