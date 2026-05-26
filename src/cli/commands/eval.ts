import path from "node:path";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext } from "./shared.js";
import { readJson } from "../../core/fs.js";
import {
  appendEvalCycle,
  ensureEvalStore,
  normalizeEvalCycleInput,
  readEvalScorecard,
  validateEvalCycle,
} from "../../core/eval/ledger.js";
import { verifyCycleEvidencePack } from "../../core/cycle/pack.js";
import { appendRunLog } from "../../core/runlog.js";
import type { CommandContext } from "../types.js";
import type { CycleRecord, EvalCycleRecord, JsonObject } from "../../core/types.js";

const HELP = [
  "Usage:",
  "  ato eval scorecard",
  "  ato eval cycle --cycle-id <cycle-id> [--record]",
  "  ato eval pack --path <pack>",
  "",
  "Options:",
  "  --help              Show help",
  "  --record            Append an explicit eval cycle record",
].join("\n");

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const toRelativePath = (root: string, filePath: string): string =>
  toPosixPath(path.relative(root, filePath) || filePath);

const writeUnknownSubcommand = (json: boolean, message: string): void => {
  if (json) {
    writeJson({ ok: false, code: 1, error: { message } });
  } else {
    writeLines([message, "", HELP]);
  }
  process.exitCode = 1;
};

export const runEvalCommand = async ({
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

  if (subcommand === "scorecard") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const scorecard = await readEvalScorecard(target.storePath);
    if (json) {
      writeJson({ ok: true, scorecard });
    } else {
      writeLines([
        formatTargetLine(target),
        `cycles: ${scorecard.cycles}`,
        `outcomes: ok=${scorecard.outcomes.ok} fail=${scorecard.outcomes.fail} inconclusive=${scorecard.outcomes.inconclusive} unknown=${scorecard.outcomes.unknown}`,
        `checks: total=${scorecard.checks.total} ok=${scorecard.checks.ok} fail=${scorecard.checks.fail} skipped=${scorecard.checks.skipped} unknown=${scorecard.checks.unknown}`,
        scorecard.last_cycle_id ? `last cycle: ${scorecard.last_cycle_id}` : null,
      ]);
    }
    return;
  }

  if (subcommand === "pack") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    const packPath =
      typeof flags["path"] === "string"
        ? flags["path"]
        : typeof flags["pack"] === "string"
          ? flags["pack"]
          : "";
    if (!packPath) {
      writeUnknownSubcommand(json, "Missing --path for eval pack.");
      return;
    }
    const manifestPath =
      typeof flags["manifest"] === "string" ? flags["manifest"] : undefined;
    const expectedPackSha =
      typeof flags["expected-sha"] === "string"
        ? flags["expected-sha"]
        : typeof flags["sha256"] === "string"
          ? flags["sha256"]
          : null;
    const result = await verifyCycleEvidencePack({
      root: target.root,
      packPath,
      ...(manifestPath ? { manifestPath } : {}),
      expectedPackSha,
    });
    if (json) {
      writeJson({ ok: result.ok, eval: { kind: "pack", result } });
    } else {
      writeLines([
        formatTargetLine(target),
        `pack: ${result.pack_path}`,
        `status: ${result.ok ? "ok" : "fail"}`,
        `verified files: ${result.verified_files_count}`,
      ]);
    }
    if (!result.ok) process.exitCode = 3;
    return;
  }

  if (subcommand === "cycle") {
    const target = await resolveTargetContext({
      context,
      requireWrite: Boolean(flags["record"]),
    });
    const cycleId =
      typeof flags["cycle-id"] === "string"
        ? flags["cycle-id"]
        : typeof flags["cycle"] === "string"
          ? flags["cycle"]
          : "";
    if (!cycleId) {
      writeUnknownSubcommand(json, "Missing --cycle-id for eval cycle.");
      return;
    }
    const cycleRecordPath = path.join(
      target.storePath,
      "cycles",
      cycleId,
      "cycle-record.json",
    );
    const cycleRecord = await readJson<CycleRecord>(cycleRecordPath, null);
    if (!cycleRecord) {
      writeUnknownSubcommand(
        json,
        `Missing cycle record for ${cycleId}: ${toRelativePath(target.root, cycleRecordPath)}`,
      );
      return;
    }

    const cycleRecordRel = toRelativePath(target.root, cycleRecordPath);
    const evalInput: JsonObject = {
      id: cycleRecord.id,
      ts: new Date().toISOString(),
      ...(cycleRecord.queue_id ? { queue_id: cycleRecord.queue_id } : {}),
      cycle_index: cycleRecord.cycle_index,
      hypothesis: cycleRecord.hypothesis,
      acceptance_checks: cycleRecord.acceptance_checks,
      evidence: [...cycleRecord.evidence, `file:${cycleRecordRel}`],
      outcome: cycleRecord.outcome,
      negative_report: {
        type: "cost",
        summary: "Explicit eval imported an existing product cycle record.",
        evidence: [`file:${cycleRecordRel}`],
      },
      seeding_result: {
        outcome: "no_seed",
        summary: "Eval command did not seed queue items.",
        evidence: [`file:${cycleRecordRel}`],
      },
      selection_evidence: cycleRecord.selection_evidence,
      gate_evidence: cycleRecord.gate_evidence,
      preflight_evidence: cycleRecord.preflight_evidence,
      ...(cycleRecord.pack_ref ? { pack_ref: cycleRecord.pack_ref } : {}),
      ...(cycleRecord.pack_verify_ref
        ? { pack_verify_ref: cycleRecord.pack_verify_ref }
        : {}),
      checks: cycleRecord.checks,
    };
    const evalRecord = normalizeEvalCycleInput({
      input: evalInput,
      fallbackId: cycleRecord.id,
      root: target.root,
    });
    const validation = await validateEvalCycle({
      record: evalRecord,
      root: target.root,
      store: target.storePath,
    });

    let scorecard: Awaited<ReturnType<typeof readEvalScorecard>> | null = null;
    if (flags["record"]) {
      if (!validation.ok) {
        writeJsonOrLines(json, {
          target,
          cycleId,
          evalRecord,
          validation,
          recorded: false,
        });
        process.exitCode = 3;
        return;
      }
      await ensureEvalStore({
        store: target.storePath,
        config: target.config,
        targetId: target.id,
      });
      scorecard = await appendEvalCycle({
        store: target.storePath,
        record: evalRecord,
      });
      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "eval_cycle_record",
        target_id: target.id,
        ...(cycleRecord.queue_id ? { queue_id: cycleRecord.queue_id } : {}),
        commands: [],
        artifacts: [cycleRecordRel],
        summary: "explicit eval cycle record",
      });
    }

    writeJsonOrLines(json, {
      target,
      cycleId,
      evalRecord,
      validation,
      recorded: Boolean(flags["record"]),
      scorecard,
    });
    if (!validation.ok) process.exitCode = 3;
    return;
  }

  writeUnknownSubcommand(json, "Unknown eval subcommand.");
};

const writeJsonOrLines = (
  json: boolean,
  {
    target,
    cycleId,
    evalRecord,
    validation,
    recorded,
    scorecard,
  }: {
    target: Awaited<ReturnType<typeof resolveTargetContext>>;
    cycleId: string;
    evalRecord: EvalCycleRecord;
    validation: { ok: boolean; errors: string[]; guidance: string[] };
    recorded: boolean;
    scorecard?: Awaited<ReturnType<typeof readEvalScorecard>> | null;
  },
): void => {
  if (json) {
    writeJson({
      ok: validation.ok,
      eval: {
        kind: "cycle",
        cycle_id: cycleId,
        recorded,
        record: evalRecord,
        validation,
        ...(scorecard ? { scorecard } : {}),
      },
    });
    return;
  }
  writeLines([
    formatTargetLine(target),
    `cycle: ${cycleId}`,
    `status: ${validation.ok ? "ok" : "fail"}`,
    `recorded: ${recorded ? "yes" : "no"}`,
    ...validation.errors.map((entry) => `- ${entry}`),
  ]);
};
