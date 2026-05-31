import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  verifyBlockSeal,
  computeGateObligations,
  blockSealPath,
} from "../../core/blocks/seal.js";
import { buildBlockReport } from "../../core/blocks/report.js";
import { loadBlockConfig } from "../../core/blocks/config.js";
import {
  readJson,
  stableStringify,
  writeJson as writeJsonFile,
} from "../../core/fs.js";
import { readCycleRecords } from "../../core/cycle/store.js";
import { isIsoDate } from "../../core/queue/transitions.js";
import type { CycleRecord, JsonValue } from "../../core/types.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato block seal verify --block-id <block-id>",
  "  ato block report --block-id <block-id>",
  "  ato block close --block-id <block-id>",
  "  ato block open --block-id <block-id> --baseline <tag>",
  "",
  "Examples:",
  "  ato block seal verify --block-id block-0005 --json",
  "  ato block report --block-id block-0005 --json",
  "  ato block close --block-id block-0005 --json",
  "  ato block open --block-id block-0006 --baseline baseline-main --json",
].join("\n");

const BLOCK_SEAL_SCHEMA = "block-seal-verify.v1";
const BLOCK_CLOSE_SCHEMA = "block-closure.v1";

const toRelativePath = (root: string, filePath: string): string =>
  path.relative(root, filePath).replace(/\\/g, "/");

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const hashStringSha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const recordMatchesBlock = (record: CycleRecord, blockId: string): boolean =>
  record.block_id === blockId;

const resolveClosureTimestamp = async ({
  store,
  blockId,
}: {
  store: string;
  blockId: string;
}): Promise<string> => {
  const records = await readCycleRecords(store);
  const timestamps = records
    .filter((record) => recordMatchesBlock(record, blockId))
    .map((record) => record.ts)
    .filter((value): value is string => isIsoDate(value));
  if (!timestamps.length) {
    return "1970-01-01T00:00:00.000Z";
  }
  timestamps.sort((a, b) => a.localeCompare(b));
  const latest = timestamps[timestamps.length - 1];
  return latest ?? "1970-01-01T00:00:00.000Z";
};

export const runBlockCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags, positionals } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  const requiresWrite = subcommand === "close" || subcommand === "open";
  const target = await resolveTargetContext({ context, requireWrite: requiresWrite });
  await ensureProtocol(target.root);

  if (subcommand === "seal") {
    const action = positionals[0];
    if (action !== "verify") {
      if (json) {
        writeJson({ ok: false, code: 1, error: { message: "Unknown block seal action." } });
      } else {
        writeLines(["Unknown block seal action.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const blockId =
      typeof flags["block-id"] === "string"
        ? flags["block-id"]
        : typeof flags["blockId"] === "string"
          ? flags["blockId"]
          : "";
    if (!blockId) {
      if (json) {
        writeJson({
          ok: false,
          code: 1,
          error: { message: "Missing --block-id." },
        });
      } else {
        writeLines(["Missing --block-id.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const result = await verifyBlockSeal({
      root: target.root,
      store: target.storePath,
      targetId: target.id,
      config: target.config,
      blockId,
    });

    const payload = {
      schema_version: BLOCK_SEAL_SCHEMA,
      ...result,
    };

    if (json) {
      writeJson(payload);
    } else {
      const lines = [
        formatTargetLine(target),
        `block: ${blockId}`,
        `seal: ${result.seal_path}`,
        `hash: ${result.obligations_hash}`,
        `status: ${result.ok ? "ok" : "fail"}`,
        ...result.errors.map((error) => `- ${error.kind}: ${error.message}`),
      ];
      if (result.guidance.length) {
        lines.push("guidance:");
        lines.push(...result.guidance.map((entry) => `- ${entry}`));
      }
      writeLines(lines);
    }

    if (!result.ok) {
      process.exitCode = 3;
    }
    return;
  }

  if (subcommand === "report") {
    const blockId =
      typeof flags["block-id"] === "string"
        ? flags["block-id"]
        : typeof flags["blockId"] === "string"
          ? flags["blockId"]
          : "";
    if (!blockId) {
      if (json) {
        writeJson({
          ok: false,
          code: 1,
          error: { message: "Missing --block-id." },
        });
      } else {
        writeLines(["Missing --block-id.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const { report, ok, errors } = await buildBlockReport({
      root: target.root,
      store: target.storePath,
      blockId,
    });

    if (json) {
      writeJson(report);
    } else {
      const warnings = report.consistency?.warnings ?? [];
      const lines = [
        formatTargetLine(target),
        `block: ${blockId}`,
        `cycles: ${report.cycles_recorded}/${report.cycles_planned}`,
        `status: ${ok ? "ok" : "fail"}`,
        `missing artifacts: ${report.missing_artifacts.length}`,
        ...(errors.length ? ["errors:", ...errors.map((err) => `- ${err}`)] : []),
        ...(warnings.length
          ? ["warnings:", ...warnings.map((warn) => `- ${warn}`)]
          : []),
      ];
      writeLines(lines);
    }

    if (!ok) {
      process.exitCode = 3;
    }
    return;
  }

  if (subcommand === "close") {
    const blockId =
      typeof flags["block-id"] === "string"
        ? flags["block-id"]
        : typeof flags["blockId"] === "string"
          ? flags["blockId"]
          : "";
    if (!blockId) {
      if (json) {
        writeJson({
          ok: false,
          code: 1,
          error: { message: "Missing --block-id." },
        });
      } else {
        writeLines(["Missing --block-id.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const blockPath = path.join(
        target.storePath,
        "meta",
        "blocks",
        `${blockId}.json`,
      );
      const blockConfig = await readJson<Record<string, unknown> | null>(blockPath, null);
      if (!blockConfig) {
        throw new Error(`Block config missing for ${blockId}.`);
      }

      const closurePath = path.join(
        target.storePath,
        "meta",
        "blocks",
        `${blockId}.closure.json`,
      );
      const closureExists = await fs
        .access(closurePath)
        .then(() => true)
        .catch(() => false);

      const { report, ok, errors } = await buildBlockReport({
        root: target.root,
        store: target.storePath,
        blockId,
      });

      const reportDir = path.join(target.storePath, "closeout");
      const reportPath = path.join(reportDir, `${blockId}.report.json`);
      if (!ok) {
        if (json) {
          writeJson({
            ok: false,
            schema_version: BLOCK_CLOSE_SCHEMA,
            block_id: blockId,
            report_path: toRelativePath(target.root, reportPath),
            errors,
          });
        } else {
          const lines = [
            formatTargetLine(target),
            `block close: ${blockId}`,
            `report: ${toRelativePath(target.root, reportPath)}`,
            "status: fail",
            ...(errors.length ? ["errors:", ...errors.map((err) => `- ${err}`)] : []),
          ];
          writeLines(lines);
        }
        process.exitCode = 3;
        return;
      }

      let reportRefPath = toRelativePath(target.root, reportPath);
      let reportSha = "";
      if (closureExists) {
        const existing = await readJson<Record<string, unknown> | null>(closurePath, null);
        const reportRefRaw =
          existing &&
          typeof existing["report_ref"] === "object" &&
          existing["report_ref"] !== null &&
          !Array.isArray(existing["report_ref"])
            ? (existing["report_ref"] as Record<string, unknown>)
            : null;
        const existingReportPath =
          reportRefRaw && typeof reportRefRaw["path"] === "string"
            ? reportRefRaw["path"].trim()
            : "";
        const existingReportSha =
          reportRefRaw && typeof reportRefRaw["sha256"] === "string"
            ? reportRefRaw["sha256"].trim()
            : "";
        if (existingReportPath && existingReportSha) {
          reportRefPath = existingReportPath;
          reportSha = existingReportSha;
        }
      } else {
        await writeJsonFile(reportPath, report);
        reportSha = await hashFileSha256(reportPath);
      }

      const closedAt = await resolveClosureTimestamp({
        store: target.storePath,
        blockId,
      });

      const closurePayload = {
        schema_version: BLOCK_CLOSE_SCHEMA,
        blockId,
        closed_at: closedAt,
        report_ref: {
          path: reportRefPath,
          sha256: reportSha,
        },
        cycles_planned: report.cycles_planned,
        cycles_recorded: report.cycles_recorded,
      };
      const expectedSerialized = stableStringify(closurePayload);
      if (closureExists) {
        const existing = await readJson<JsonValue | null>(closurePath, null);
        if (!existing) {
          throw new Error(`Block ${blockId} closure is missing.`);
        }
        const existingSerialized = stableStringify(existing as JsonValue);
        if (existingSerialized !== expectedSerialized) {
          const expectedHash = hashStringSha256(expectedSerialized);
          const existingHash = hashStringSha256(existingSerialized);
          const errors = [
            `closure mismatch: expected ${expectedHash} got ${existingHash}`,
          ];
          if (json) {
            writeJson({
              ok: false,
              schema_version: BLOCK_CLOSE_SCHEMA,
              block_id: blockId,
              closure_path: toRelativePath(target.root, closurePath),
              report_path: toRelativePath(target.root, reportPath),
              errors,
            });
          } else {
            const lines = [
              formatTargetLine(target),
              `block close: ${blockId}`,
              `report: ${toRelativePath(target.root, reportPath)}`,
              "status: fail",
              "errors:",
              ...errors.map((err) => `- ${err}`),
            ];
            writeLines(lines);
          }
          process.exitCode = 3;
          return;
        }
      } else {
        await writeJsonFile(closurePath, closurePayload);
      }

      if (json) {
        writeJson({
          ok: true,
          schema_version: BLOCK_CLOSE_SCHEMA,
          block_id: blockId,
          closure_path: toRelativePath(target.root, closurePath),
          report_path: toRelativePath(target.root, reportPath),
          errors,
        });
      } else {
        const lines = [
          formatTargetLine(target),
          `block close: ${blockId}`,
          `report: ${toRelativePath(target.root, reportPath)}`,
          `status: ${ok ? "ok" : "fail"}`,
          ...(errors.length ? ["errors:", ...errors.map((err) => `- ${err}`)] : []),
        ];
        writeLines(lines);
      }
      if (!ok) {
        process.exitCode = 3;
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "open") {
    const blockId =
      typeof flags["block-id"] === "string"
        ? flags["block-id"]
        : typeof flags["blockId"] === "string"
          ? flags["blockId"]
          : "";
    const baseline =
      typeof flags["baseline"] === "string"
        ? flags["baseline"]
        : typeof flags["baselineTag"] === "string"
          ? flags["baselineTag"]
          : "";
    if (!blockId || !baseline) {
      if (json) {
        writeJson({
          ok: false,
          code: 1,
          error: { message: "Missing --block-id or --baseline." },
        });
      } else {
        writeLines(["Missing --block-id or --baseline.", "", HELP]);
      }
      process.exitCode = 1;
      return;
    }

    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
    try {
      const existingPath = path.join(
        target.storePath,
        "meta",
        "blocks",
        `${blockId}.json`,
      );
      const blockExists = await fs
        .access(existingPath)
        .then(() => true)
        .catch(() => false);
      if (blockExists) {
        throw new Error(`Block ${blockId} already exists.`);
      }

      const baseBlock = await loadBlockConfig(target.storePath);
      if (!baseBlock) {
        throw new Error("No existing block config found to clone.");
      }

      const nextBlock = JSON.parse(JSON.stringify(baseBlock)) as Record<
        string,
        unknown
      >;
      nextBlock["blockId"] = blockId;
      nextBlock["frozen"] = true;
      const baselineObj =
        nextBlock["baseline"] && typeof nextBlock["baseline"] === "object"
          ? (nextBlock["baseline"] as Record<string, unknown>)
          : {};
      nextBlock["baseline"] = { ...baselineObj, tag: baseline };

      await writeJsonFile(existingPath, nextBlock as JsonValue);

      const obligations = await computeGateObligations({
        root: target.root,
        targetId: target.id,
        config: target.config,
        blockId,
      });
      const sealPayload = {
        schema_version: "block-seal.v1",
        block_id: blockId,
        obligations_hash: obligations.obligations_hash,
        inputs: obligations.inputs,
      };
      const sealPath = blockSealPath(target.storePath, blockId);
      await writeJsonFile(sealPath, sealPayload);

      if (json) {
        writeJson({
          ok: true,
          schema_version: "block-open.v1",
          block_id: blockId,
          block_path: toRelativePath(target.root, existingPath),
          seal_path: toRelativePath(target.root, sealPath),
        });
      } else {
        writeLines([
          formatTargetLine(target),
          `block open: ${blockId}`,
          `seal: ${toRelativePath(target.root, sealPath)}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand !== "report") {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown block subcommand." } });
    } else {
      writeLines(["Unknown block subcommand.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }
};
