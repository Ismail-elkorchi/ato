import path from "node:path";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { buildComplianceReport } from "../../core/contracts/compliance.js";
import { CAPABILITIES } from "../../core/capability/manifest.js";
import { readJson } from "../../core/fs.js";
import { buildDocDeltaReport } from "../../core/docs/index.js";
import { buildDocsTruthReport } from "../../core/docs/truth.js";
import { getArtifactsDir } from "../../core/runlog.js";
import { readState } from "../../core/state.js";
import type { CommandContext } from "../types.js";
import type { ContractIndex } from "../../core/contracts/index.js";
import type { DocDeltaEntry } from "../../core/docs/index.js";

const HELP = [
  "Usage: ato docs delta|truth [options]",
  "",
  "Subcommands:",
  "  delta                 Generate doc update deltas",
  "  truth                 Validate major-doc truth labels and evidence pointers",
  "",
  "Options (delta):",
  "  --patch               Emit patch suggestions",
  "",
  "Examples:",
  "  ato docs delta",
  "  ato docs delta --patch",
  "  ato docs truth --json",
].join("\n");

const indexPathFor = (store: string) =>
  path.join(store, "cache", "contracts.index.json");

const resolveDocPaths = async (root: string, store: string) => {
  const docs = [
    { path: path.join(root, "README.md"), required: true },
    { path: path.join(root, "docs", "USER_GUIDE.md"), required: true },
  ];
  const index = await readJson<ContractIndex>(indexPathFor(store), null);
  if (index) {
    for (const doc of index.docs ?? []) {
      docs.push({ path: doc.doc, required: false });
    }
  }
  const map = new Map<string, string>();
  for (const doc of docs) {
    const resolved = path.resolve(root, doc.path);
    const rel = path.relative(root, resolved);
    const displayPath = rel || resolved;
    map.set(displayPath.replace(/\\/g, "/"), resolved);
  }
  return { docs, map };
};

const commandLabel = (entry: {
  command: string;
  subcommand: string | null;
  id: string;
  source: { path: string; line: number };
}): string => {
  const base = entry.subcommand
    ? `ato ${entry.command} ${entry.subcommand}`
    : `ato ${entry.command}`;
  return `${base} (${entry.id}) source: ${entry.source.path}:${entry.source.line}`;
};

const buildPatchAdditions = (entry: DocDeltaEntry): string[] => {
  const additions = entry.missing.map((missing) => `- ${commandLabel(missing)}`);
  if (!additions.length) return [];
  return ["", "## TODO: Document new commands", ...additions];
};

const lineCountFor = (content: string): number => {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n")) return Math.max(lines.length - 1, 0);
  return lines.length;
};

const createAppendPatch = ({
  displayPath,
  content,
  additions,
}: {
  displayPath: string;
  content: string;
  additions: string[];
}): string => {
  const lineCount = lineCountFor(content);
  const header = [
    `diff --git a/${displayPath} b/${displayPath}`,
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -${lineCount},0 +${lineCount + 1},${additions.length} @@`,
  ];
  const body = additions.map((line) => `+${line}`);
  return [...header, ...body, ""].join("\n");
};

export const runDocsCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand === "truth") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const report = await buildDocsTruthReport({ root: target.root });
    if (json) {
      writeJson(report);
    } else {
      const lines = [
        formatTargetLine(target),
        `docs truth: ${report.ok ? "ok" : "fail"}`,
        `docs: ${report.summary.docs}`,
        `claims: ${report.summary.claims}`,
        `labels: implemented=${report.summary.implemented}, planned=${report.summary.planned}, unknown=${report.summary.unknown}`,
        `issues: errors=${report.summary.errors}, warnings=${report.summary.warnings}`,
      ];
      for (const issue of report.issues.slice(0, 20)) {
        const location = issue.line ? `${issue.doc}:${issue.line}` : issue.doc;
        lines.push(`- ${issue.level.toUpperCase()} ${issue.code} @ ${location}`);
        lines.push(`  ${issue.message}`);
      }
      if (report.issues.length > 20) {
        lines.push(`- ... ${report.issues.length - 20} more issue(s)`);
      }
      writeLines(lines);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (subcommand !== "delta") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown docs subcommand." } });
    } else {
      writeLines(["Unknown docs subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const wantPatch = Boolean(flags["patch"]);
  const target = await resolveTargetContext({ context, requireWrite: wantPatch });
  await ensureProtocol(target.root);
  const lockPath = wantPatch
    ? await acquireWriteLock(target, target.config.lock?.ttlMs)
    : null;
  try {
    const { docs, map: docPathMap } = await resolveDocPaths(
      target.root,
      target.storePath,
    );
    const report = await buildComplianceReport({
      root: target.root,
      manifestPath: path.join(
        target.root,
        "src",
        "core",
        "capability",
        "manifest.ts",
      ),
      capabilities: CAPABILITIES,
      docs,
    });
    const delta = buildDocDeltaReport(report);
    const patches: Array<{ path: string; patchPath: string; diff: string }> = [];
    if (wantPatch && delta.files.length) {
      const state = await readState(target.storePath);
      const artifactsDir = getArtifactsDir(
        target.storePath,
        state.activeQueueId ?? null,
        "docs",
      );
      await fs.mkdir(artifactsDir, { recursive: true });

      for (const entry of delta.files) {
        if (!entry.missing.length) continue;
        const resolved = docPathMap.get(entry.path);
        if (!resolved) continue;
        const content = await fs.readFile(resolved, "utf8").catch(() => "");
        const additions = buildPatchAdditions(entry);
        if (!additions.length) continue;
        const diff = createAppendPatch({
          displayPath: entry.path,
          content,
          additions,
        });
        const safeName = entry.path.replace(/[^\w.-]+/g, "_");
        const patchPath = path.join(
          artifactsDir,
          `doc-delta-${safeName}.patch`,
        );
        await fs.writeFile(patchPath, diff, "utf8");
        patches.push({ path: entry.path, patchPath, diff });
      }
    }

    if (json) {
      writeJson({
        ok: true,
        summary: delta.summary,
        files: delta.files,
        patches: patches.map((entry) => ({
          path: entry.path,
          patchPath: entry.patchPath,
        })),
      });
    } else {
      const lines = [
        formatTargetLine(target),
        `docs delta: ${delta.summary.files} files`,
        `missing entries: ${delta.summary.missing}`,
        `removed entries: ${delta.summary.removed}`,
      ];
      if (delta.files.length) {
        for (const entry of delta.files) {
          lines.push("", `File: ${entry.path}`);
          if (entry.missing.length) {
            lines.push("  Missing:");
            for (const missing of entry.missing) {
              lines.push(`  - ${commandLabel(missing)}`);
            }
          }
          if (entry.removed.length) {
            lines.push("  Removed:");
            for (const removed of entry.removed) {
              const label = removed.subcommand
                ? `ato ${removed.command} ${removed.subcommand}`
                : `ato ${removed.command}`;
              lines.push(`  - ${label}`);
              for (const ref of removed.docRefs) {
                lines.push(`    doc: ${ref.path}:${ref.line}`);
              }
            }
          }
        }
      }
      if (patches.length) {
        lines.push("", "Patch artifacts:");
        lines.push(...patches.map((entry) => `- ${entry.patchPath}`));
      }
      writeLines(lines);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};
