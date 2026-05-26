#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const HELP = `Usage: node scripts/check-path-hygiene.mjs [options]

Deterministically scan tracked .ato/** artifacts for absolute filesystem paths.

Options:
  --root <path>      Repository root (default: current working directory)
  --write            Rewrite tracked .ato artifacts to path-hygienic form
  --json             Emit machine-readable JSON output
  --report-only      Always exit 0 for diagnostics
  --help             Show this help
`;

const ABSOLUTE_TOKEN_RE =
  /(?:[A-Za-z]:\\(?![nrtbfu"\\/])(?:[^\\\s"'`<>{},;()]+(?:\\[^\\\s"'`<>{},;()]+)*)|\/(?:home|Users|tmp|var|etc|private|Volumes|mnt|srv|root)(?:\/[^\s"'`<>{},;()]+)+)(?::\d+(?::\d+)?)?/g;

const PATH_SUFFIX_RE = /^(.*?)(:\d+(?::\d+)?)$/;

const isBinaryText = (value) => value.includes("\u0000");

const toPosix = (value) => value.replace(/\\/g, "/");

const splitPathSuffix = (value) => {
  const match = value.match(PATH_SUFFIX_RE);
  if (!match) return { path: value, suffix: "" };
  return { path: match[1] ?? value, suffix: match[2] ?? "" };
};

const inRoot = (rootPosix, valuePosix) =>
  valuePosix === rootPosix || valuePosix.startsWith(`${rootPosix}/`);

const symbolJoin = (head, tail) => {
  const trimmed = tail.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!trimmed) return head;
  return `${head}/${trimmed}`;
};

const normalizeAbsolutePath = ({
  absolutePath,
  rootPosix,
  homePosix,
  tmpPosix,
}) => {
  const value = toPosix(absolutePath);
  if (inRoot(rootPosix, value)) {
    const relative = path.posix.relative(rootPosix, value);
    return relative || ".";
  }

  if (tmpPosix && (value === tmpPosix || value.startsWith(`${tmpPosix}/`))) {
    const tail = value === tmpPosix ? "" : value.slice(tmpPosix.length + 1);
    return symbolJoin("$TMPDIR", tail);
  }

  if (value === "/tmp" || value.startsWith("/tmp/")) {
    return symbolJoin("$TMPDIR", value.slice("/tmp".length));
  }
  if (value === "/private/tmp" || value.startsWith("/private/tmp/")) {
    return symbolJoin("$TMPDIR", value.slice("/private/tmp".length));
  }
  if (value === "/var/tmp" || value.startsWith("/var/tmp/")) {
    return symbolJoin("$TMPDIR", value.slice("/var/tmp".length));
  }

  if (homePosix && (value === homePosix || value.startsWith(`${homePosix}/`))) {
    const tail = value === homePosix ? "" : value.slice(homePosix.length + 1);
    return symbolJoin("$HOME", tail);
  }

  const userHome = value.match(/^\/(?:home|Users)\/[^/]+(?:\/(.*))?$/);
  if (userHome) {
    return symbolJoin("$HOME", userHome[1] ?? "");
  }

  const windows = value.match(/^([A-Za-z]):\/(.*)$/);
  if (windows) {
    return symbolJoin("<external>", `${windows[1].toLowerCase()}/${windows[2]}`);
  }

  if (value.startsWith("/")) {
    return symbolJoin("<external>", value.slice(1));
  }

  return symbolJoin("<external>", path.posix.basename(value));
};

const replaceAbsoluteTokensInString = (value, context) =>
  value.replace(ABSOLUTE_TOKEN_RE, (token) => {
    let core = token;
    let trailing = "";
    while (/[),.;\]}]+$/.test(core)) {
      trailing = core.slice(-1) + trailing;
      core = core.slice(0, -1);
    }
    const { path: tokenPath, suffix } = splitPathSuffix(core);
    const normalized = normalizeAbsolutePath({
      absolutePath: tokenPath,
      rootPosix: context.rootPosix,
      homePosix: context.homePosix,
      tmpPosix: context.tmpPosix,
    });
    return `${normalized}${suffix}${trailing}`;
  });

const transformJsonValue = (value, context) => {
  if (typeof value === "string") {
    return replaceAbsoluteTokensInString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => transformJsonValue(entry, context));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = transformJsonValue(entry, context);
    }
    return out;
  }
  return value;
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
};

const computeQueueCoreHash = (item) => {
  const snapshot = {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    target: item.target,
    deps: item.deps,
    created_at: item.created_at,
    completed_at: item.completed_at ?? null,
    notes: item.notes,
    spec: item.spec ?? null,
    details: item.details ?? null,
  };
  const serialized = stableStringify(snapshot);
  return crypto.createHash("sha256").update(serialized).digest("hex");
};

const rewriteJson = (raw, context) => {
  const parsed = JSON.parse(raw);
  const transformed = transformJsonValue(parsed, context);
  if (stableStringify(parsed) === stableStringify(transformed)) {
    return raw;
  }
  return `${JSON.stringify(transformed, null, 2)}\n`;
};

const rewriteJsonl = (raw, context, relativePath) => {
  const lines = raw.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    if (!line.trim()) return "";
    try {
      const parsed = JSON.parse(line);
      const transformed = transformJsonValue(parsed, context);
      const baseSnapshot = stableStringify(transformed);
      if (
        relativePath === ".ato/queue/items.jsonl" &&
        transformed &&
        typeof transformed === "object" &&
        transformed.status === "done"
      ) {
        transformed.frozen = {
          ...(transformed.frozen && typeof transformed.frozen === "object"
            ? transformed.frozen
            : {}),
          core_hash: computeQueueCoreHash(transformed),
        };
      }
      const changed = stableStringify(transformed) !== stableStringify(parsed);
      if (!changed && baseSnapshot === stableStringify(transformed)) {
        return line;
      }
      return JSON.stringify(transformed);
    } catch {
      return replaceAbsoluteTokensInString(line, context);
    }
  });
  return `${rewritten.filter((line) => line.length > 0).join("\n")}\n`;
};

const rewriteText = (raw, context) => replaceAbsoluteTokensInString(raw, context);

const collectHits = (filePath, raw) => {
  if (isBinaryText(raw)) return [];
  const lines = raw.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    ABSOLUTE_TOKEN_RE.lastIndex = 0;
    const found = new Set();
    let match;
    while ((match = ABSOLUTE_TOKEN_RE.exec(line)) !== null) {
      found.add(match[0]);
    }
    if (found.size === 0) continue;
    for (const entry of [...found].sort((a, b) => a.localeCompare(b))) {
      hits.push({
        file: filePath,
        line: i + 1,
        match: entry,
        excerpt: line.length > 180 ? `${line.slice(0, 177)}...` : line,
      });
    }
  }
  return hits;
};

const parseArgs = (argv) => {
  const args = [...argv];
  const options = {
    root: process.cwd(),
    write: false,
    json: false,
    reportOnly: false,
  };
  while (args.length) {
    const current = args.shift();
    if (!current) break;
    if (current === "--help" || current === "-h") {
      options.help = true;
      continue;
    }
    if (current === "--write") {
      options.write = true;
      continue;
    }
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--report-only") {
      options.reportOnly = true;
      continue;
    }
    if (current === "--root") {
      const next = args.shift();
      if (!next) throw new Error("--root requires a value.");
      options.root = next;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  return options;
};

const runGit = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const trackedAtoFiles = (root) => {
  const output = runGit(root, ["ls-files", "--", ".ato"]);
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
};

const rewriteTrackedFile = async (absolutePath, relativePath, context) => {
  const raw = await fs.readFile(absolutePath, "utf8");
  if (isBinaryText(raw)) return { changed: false };
  let next = raw;
  if (relativePath.endsWith(".jsonl")) {
    next = rewriteJsonl(raw, context, relativePath);
  } else if (relativePath.endsWith(".json")) {
    try {
      next = rewriteJson(raw, context);
    } catch {
      next = rewriteText(raw, context);
      if (!next.endsWith("\n")) next += "\n";
    }
  } else {
    next = rewriteText(raw, context);
    if (!next.endsWith("\n")) next += "\n";
  }
  if (next === raw) return { changed: false };
  await fs.writeFile(absolutePath, next, "utf8");
  return { changed: true };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const root = path.resolve(options.root);
  const repoRoot = runGit(root, ["rev-parse", "--show-toplevel"]);
  const rootPosix = toPosix(repoRoot);
  const homePosix = toPosix(path.resolve(os.homedir()));
  const tmpPosix = toPosix(path.resolve(os.tmpdir()));
  const context = { rootPosix, homePosix, tmpPosix };

  const files = trackedAtoFiles(repoRoot);
  const changedFiles = [];

  if (options.write) {
    for (const file of files) {
      const abs = path.join(repoRoot, file);
      const result = await rewriteTrackedFile(abs, file, context);
      if (result.changed) changedFiles.push(file);
    }
  }

  const hits = [];
  for (const file of files) {
    const abs = path.join(repoRoot, file);
    const raw = await fs.readFile(abs, "utf8");
    hits.push(...collectHits(file, raw));
  }

  hits.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.match.localeCompare(b.match),
  );

  const payload = {
    ok: hits.length === 0,
    schema_version: "path-hygiene-check.v1",
    root: rootPosix,
    checked_files: files.length,
    changed_files: changedFiles.sort((a, b) => a.localeCompare(b)),
    count: hits.length,
    hits,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (hits.length === 0) {
    process.stdout.write(
      `path hygiene ok: ${files.length} tracked .ato files checked\n`,
    );
  } else {
    process.stdout.write(
      `path hygiene failed: ${hits.length} absolute path hits in tracked .ato artifacts\n`,
    );
    for (const hit of hits) {
      process.stdout.write(`${hit.file}:${hit.line}: ${hit.match}\n`);
    }
  }

  if (hits.length > 0 && !options.reportOnly) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  process.stderr.write(`${(error && error.message) || String(error)}\n`);
  process.exitCode = 1;
});
