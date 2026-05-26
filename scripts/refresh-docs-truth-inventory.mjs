#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MAJOR_DOCS = [
  "README.md",
  "docs/USER_GUIDE.md",
  "docs/LLM_GUIDE.md",
  "docs/CAPABILITY_GUIDE.md",
  "docs/PLUGIN_GUIDE.md",
];

const TRUTH_SECTION_HEADING_RE = /^##\s+Truth Claims\s*$/i;
const SECOND_LEVEL_HEADING_RE = /^##\s+/;
const CLAIM_RE =
  /^\s*-\s+\[(implemented|planned|unknown)\]\s+(.+?)(?:\s+\|\s+evidence:\s*(.+))?\s*$/i;

const toPosix = (value) => value.replace(/\\/g, "/");

const normalizeEvidencePath = (value) => {
  const trimmed = String(value ?? "").trim().replace(/^`|`$/g, "");
  const withoutPrefix = trimmed.replace(/^file:/i, "");
  const withoutDotSlash = withoutPrefix.startsWith("./")
    ? withoutPrefix.slice(2)
    : withoutPrefix;
  return toPosix(withoutDotSlash);
};

const parseEvidenceList = (raw) => {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[;,]/)
    .map((entry) => normalizeEvidencePath(entry))
    .filter(Boolean);
  return Array.from(new Set(parts)).sort((a, b) => a.localeCompare(b));
};

const collectClaims = (docPath, content) => {
  const lines = content.split(/\r?\n/);
  const claims = [];
  let inTruthSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (TRUTH_SECTION_HEADING_RE.test(line)) {
      inTruthSection = true;
      continue;
    }
    if (inTruthSection && SECOND_LEVEL_HEADING_RE.test(line)) {
      inTruthSection = false;
    }
    if (!inTruthSection) continue;
    const claimMatch = line.match(CLAIM_RE);
    if (!claimMatch) continue;
    const label = String(claimMatch[1] ?? "").toLowerCase();
    const statement = String(claimMatch[2] ?? "").trim();
    const evidence = parseEvidenceList(claimMatch[3] ?? "");
    claims.push({
      id: `${docPath}#L${index + 1}`,
      doc: docPath,
      line: index + 1,
      label,
      statement,
      evidence,
    });
  }
  return claims.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
};

const parseArgs = (argv) => {
  const options = {
    root: process.cwd(),
    out: "docs/MAJOR_DOCS_TRUTH.json",
    check: false,
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (!arg) break;
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--root") {
      const value = args.shift();
      if (!value) throw new Error("--root requires a value.");
      options.root = value;
      continue;
    }
    if (arg === "--out") {
      const value = args.shift();
      if (!value) throw new Error("--out requires a value.");
      options.out = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/refresh-docs-truth-inventory.mjs [options]",
          "",
          "Options:",
          "  --root <path>    Repo root (default: cwd)",
          "  --out <path>     Output path (default: docs/MAJOR_DOCS_TRUTH.json)",
          "  --check          Verify output is up to date (no write)",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const inventory = {
    schema_version: "docs-truth-inventory.v1",
    docs: [...MAJOR_DOCS],
    claims: [],
  };

  for (const doc of MAJOR_DOCS) {
    const absolutePath = path.join(root, doc);
    const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
    const claims = collectClaims(doc, content);
    inventory.claims.push(...claims);
  }

  inventory.claims.sort(
    (a, b) =>
      a.doc.localeCompare(b.doc) ||
      a.line - b.line ||
      a.id.localeCompare(b.id),
  );

  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  const outPath = path.resolve(root, options.out);
  if (options.check) {
    const current = await fs.readFile(outPath, "utf8").catch(() => "");
    if (current !== serialized) {
      process.stderr.write(
        `docs truth inventory is stale: ${toPosix(path.relative(root, outPath))}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `docs truth inventory is up to date: ${toPosix(path.relative(root, outPath))}\n`,
    );
    return;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, serialized, "utf8");
  process.stdout.write(
    `wrote docs truth inventory: ${toPosix(path.relative(root, outPath))}\n`,
  );
};

main().catch((error) => {
  process.stderr.write(`${(error && error.message) || String(error)}\n`);
  process.exitCode = 1;
});
