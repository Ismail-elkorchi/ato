import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  buildContractIndex,
  resolveContractDocs,
  resolveSectionFromIndex,
  toContractDocKey,
} from "../../core/contracts/index.js";
import { extractSection } from "../../core/contracts/extract.js";
import { buildComplianceReport } from "../../core/contracts/compliance.js";
import { CAPABILITIES } from "../../core/capability/manifest.js";
import { fileExists, readJson, writeJson as writeJsonFile } from "../../core/fs.js";
import { readQueueItems } from "../../core/queue/store.js";
import type { CommandContext } from "../types.js";
import type { ContractRef, TargetContext } from "../../core/types.js";
import type { ContractIndex } from "../../core/contracts/index.js";

const resolveManifestPath = async (root: string): Promise<string> => {
  const candidates = [
    path.join(root, "src", "core", "capability", "manifest.ts"),
    path.join(root, "dist", "core", "capability", "manifest.js"),
    fileURLToPath(new URL("../../core/capability/manifest.js", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("Capability manifest not found for contract compliance.");
};

const indexPathFor = (store: string) =>
  path.join(store, "cache", "contracts.index.json");

const toRelativePath = (root: string, filePath: string): string => {
  const rel = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  return rel.replace(/\\/g, "/");
};

const resolveRef = (
  ref: ContractRef,
  config: TargetContext["config"],
): { doc: string; section: string } => {
  if (typeof ref === "string") {
    const contracts = config.contracts;
    const doc =
      typeof contracts === "string"
        ? contracts
        : Array.isArray(contracts)
          ? contracts[0]
          : contracts?.platform;
    return {
      doc: doc ?? "",
      section: ref,
    };
  }
  return ref;
};

export const runContractCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;

  if (subcommand === "index") {
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const docs = resolveContractDocs(target.config, target.root);
      if (!docs.length) {
        throw new Error("No contracts configured. Set config.contracts.");
      }
      const index = await buildContractIndex(docs);
      const indexPath = indexPathFor(target.storePath);
      await writeJsonFile(indexPath, index);

      const payload = {
        ok: true,
        path: toRelativePath(target.root, indexPath),
        docs: docs.map((doc) => doc.path),
      };
      if (json) {
        writeJson(payload);
      } else {
        writeLines([
          `target: ${target.id} root: ${target.root}`,
          `index: ${toRelativePath(target.root, indexPath)}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "extract") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const { flags } = parseFlags(args);
    const indexPath = indexPathFor(target.storePath);
    const index = await readJson<ContractIndex>(indexPath, null);
    if (!index) {
      const error = new Error(
        "Missing contract index. Run `ato contract index` first.",
      );
      (error as Error & { code?: number }).code = 6;
      throw error;
    }

    let refs: Array<{ doc: string; section: string }> = [];
    if (typeof flags["queue"] === "string") {
      const records = await readQueueItems(target.storePath);
      const item = records.find(
        (record) => record.item.id === flags["queue"],
      )?.item;
      if (!item) {
        throw new Error(`Queue item ${flags["queue"]} not found.`);
      }
      const rawRefs = item.spec?.contract_refs ?? [];
      refs = rawRefs.map((ref) => resolveRef(ref, target.config));
    } else if (
      typeof flags["doc"] === "string" &&
      (flags["section"] || flags["sections"])
    ) {
      const rawSections = String(flags["section"] ?? flags["sections"])
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      refs = rawSections.map((section) => ({
        doc: flags["doc"] as string,
        section,
      }));
    } else {
      throw new Error(
        "Provide --queue <id> or --doc <path> with --section(s).",
      );
    }

    const outputs = [];
    for (const ref of refs) {
      const docKey = toContractDocKey(target.root, ref.doc);
      const docPath = path.resolve(target.root, ref.doc);
      const sectionEntry = resolveSectionFromIndex({
        index,
        doc: docKey,
        section: ref.section,
      });
      if (!sectionEntry) {
        const error = new Error(
          `Unable to resolve contract section '${ref.section}'.`,
        );
        (error as Error & { code?: number }).code = 6;
        throw error;
      }
      const extracted = await extractSection({
        index,
        doc: docPath,
        section: ref.section,
        docKey,
      });
      outputs.push({
        doc: docPath,
        section: ref.section,
        content: extracted?.content ?? "",
      });
    }

    if (json) {
      writeJson({ ok: true, sections: outputs });
    } else {
      const lines = [];
      for (const output of outputs) {
        lines.push(`# ${output.doc} (${output.section})`);
        lines.push(output.content);
        lines.push("");
      }
      writeLines(lines);
    }
    return;
  }

  if (subcommand === "compliance") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const indexPath = indexPathFor(target.storePath);
    const index = await readJson<ContractIndex>(indexPath, null);
    const requiredDocsConfig =
      target.config.contracts &&
      typeof target.config.contracts === "object" &&
      !Array.isArray(target.config.contracts)
        ? target.config.contracts.requiredDocs
        : null;
    const requiredDocs =
      Array.isArray(requiredDocsConfig) && requiredDocsConfig.length
        ? requiredDocsConfig
        : ["README.md", path.join("docs", "USER_GUIDE.md")];
    const requiredPaths = [...new Set(requiredDocs)]
      .map((doc) => path.resolve(target.root, doc))
      .sort((a, b) => a.localeCompare(b));

    const docs = requiredPaths.map((doc) => ({ path: doc, required: true }));
    if (index) {
      for (const doc of index.docs ?? []) {
        docs.push({ path: doc.doc, required: false });
      }
    }

    const manifestPath = await resolveManifestPath(target.root);
    const report = await buildComplianceReport({
      root: target.root,
      manifestPath,
      capabilities: CAPABILITIES,
      docs,
    });

    const ok = report.missingDocs.length === 0 && report.removedExports.length === 0;

    if (json) {
      writeJson({ ok, report });
    } else {
      const lines = [
        `target: ${target.id} root: ${target.root}`,
        `contract compliance: ${ok ? "ok" : "needs attention"}`,
        `exports: ${report.summary.totalExports}`,
        `missing docs: ${report.summary.missingDocs}`,
        `removed exports: ${report.summary.removedExports}`,
        "",
        "Required docs:",
        ...report.docs.required.map((doc) => `- ${doc}`),
      ];

      if (report.docs.optional.length) {
        lines.push("", "Optional docs:");
        lines.push(...report.docs.optional.map((doc) => `- ${doc}`));
      }

      if (report.missingDocs.length) {
        lines.push("", "Missing docs:");
        for (const missing of report.missingDocs) {
          const label = missing.subcommand
            ? `ato ${missing.command} ${missing.subcommand}`
            : `ato ${missing.command}`;
          lines.push(
            `- ${label} (${missing.id}) -> ${missing.source.path}:${missing.source.line}`,
          );
          lines.push(`  missing: ${missing.missingIn.join(", ")}`);
        }
      }

      if (report.removedExports.length) {
        lines.push("", "Removed exports:");
        for (const removed of report.removedExports) {
          const label = removed.subcommand
            ? `ato ${removed.command} ${removed.subcommand}`
            : `ato ${removed.command}`;
          lines.push(`- ${label}`);
          for (const ref of removed.docRefs) {
            lines.push(`  doc: ${ref.path}:${ref.line}`);
          }
        }
      }

      writeLines(lines);
    }

    process.exitCode = 0;
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown contract subcommand." },
    });
  } else {
    writeLines([
      "Unknown contract subcommand.",
      "Usage: ato contract index|extract|compliance",
    ]);
  }
  process.exitCode = 1;
};
