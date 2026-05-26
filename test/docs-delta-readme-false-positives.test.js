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

test("docs delta surfaces README false-positive command phrases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ato-docs-delta-"));
  const manifestPath = path.join(root, "src", "core", "capability", "manifest.ts");
  const readmePath = path.join(root, "README.md");
  const userGuidePath = path.join(root, "docs", "USER_GUIDE.md");

  await writeFile(
    manifestPath,
    [
      "export const CAPABILITIES = [",
      '  { id: "alpha.one" },',
      "];",
      "",
    ].join("\n"),
  );
  await writeFile(
    readmePath,
    [
      "# Sample",
      "",
      "ATO is a deterministic CLI.",
      "ATO lives in the repo root.",
      "ATO install is documented elsewhere.",
      "ATO run build to compile.",
      "- `ato is a`",
      "- `ato lives in`",
      "- `ato install`",
      "- `ato run build`",
      "- `ato alpha one`",
      "",
    ].join("\n"),
  );
  await writeFile(userGuidePath, "- `ato alpha one`\n", "utf8");

  const capabilities = [
    makeCapability({ id: "alpha.one", command: "alpha", subcommand: "one" }),
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

  const readmeEntry = delta.files.find((entry) => entry.path === "README.md");
  const removed = readmeEntry?.removed ?? [];

  assert.equal(removed.length, 0);
  assert.equal(report.missingDocs.length, 0);
});
