import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { readQueueItems } from "../queue/store.js";
import { depsSatisfied } from "../queue/ordering.js";
import { normalizeEvidence } from "../queue/transitions.js";
import { stableStringify, writeJson } from "../fs.js";
import { nextCycleIdentity } from "./store.js";
import type { QueueItem } from "../types.js";

type CommandResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PreflightSnapshot = {
  schema_version: "cycle-preflight.v1";
  captured_at: string;
  cycle: { id: string; index: number };
  target_id?: string;
  node: { version: string };
  git: {
    status_sb: string | null;
    diff_name_only: string[];
    status_error?: string;
    diff_error?: string;
  };
  queue: {
    total: number;
    eligible: number;
    status_counts: Record<string, number>;
    digest: string;
  };
};

const runCommand = async (
  cmd: string[],
  cwd: string,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const [bin, ...args] = cmd;
    if (!bin) {
      resolve({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Missing command.",
      });
      return;
    }
    const child = spawn(bin, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code: number | null) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });

const parseLines = (value: string): string[] => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  lines.sort((a, b) => a.localeCompare(b));
  return lines;
};

const hasEvidence = (item: QueueItem): boolean => {
  const evidence = normalizeEvidence(item.evidence ?? []);
  const inputs = normalizeEvidence(item.spec?.inputs ?? []);
  return evidence.length + inputs.length > 0;
};

const buildQueueDigest = (items: QueueItem[]): string => {
  const summary = items
    .map((item) => ({
      id: item.id,
      status: item.status,
      priority: item.priority,
      updated_at: item.updated_at,
      evidence_count: normalizeEvidence(item.evidence ?? []).length,
      input_count: normalizeEvidence(item.spec?.inputs ?? []).length,
      deps: item.deps ?? [],
      target: item.target ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = stableStringify(summary);
  return crypto.createHash("sha256").update(payload).digest("hex");
};

const buildQueueSummary = (items: QueueItem[]) => {
  const statusCounts: Record<string, number> = {};
  for (const item of items) {
    statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
  }
  const statusMap = new Map(items.map((item) => [item.id, item.status]));
  const eligible = items
    .filter((item) => ["active", "queued"].includes(item.status))
    .filter((item) => depsSatisfied(item, statusMap))
    .filter((item) => hasEvidence(item)).length;
  return {
    total: items.length,
    eligible,
    status_counts: statusCounts,
    digest: buildQueueDigest(items),
  };
};

const hashFile = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

export const captureCyclePreflight = async ({
  root,
  store,
  targetId,
}: {
  root: string;
  store: string;
  targetId?: string;
}): Promise<{
  cycle_id: string;
  cycle_index: number;
  path: string;
  sha256: string;
  preflight: PreflightSnapshot;
}> => {
  const identity = await nextCycleIdentity(store);

  const [statusResult, diffResult] = await Promise.all([
    runCommand(["git", "status", "-sb"], root),
    runCommand(["git", "diff", "--name-only"], root),
  ]);

  const statusOutput = statusResult.ok ? statusResult.stdout.trimEnd() : null;
  const diffLines = diffResult.ok ? parseLines(diffResult.stdout) : [];

  const queueRecords = await readQueueItems(store);
  const items = queueRecords.map((record) => record.item);

  const preflight: PreflightSnapshot = {
    schema_version: "cycle-preflight.v1",
    captured_at: new Date().toISOString(),
    cycle: { id: identity.id, index: identity.index },
    ...(targetId ? { target_id: targetId } : {}),
    node: { version: process.version },
    git: {
      status_sb: statusOutput,
      diff_name_only: diffLines,
      ...(statusResult.ok
        ? {}
        : { status_error: statusResult.stderr.trim() || "git status failed." }),
      ...(diffResult.ok
        ? {}
        : { diff_error: diffResult.stderr.trim() || "git diff failed." }),
    },
    queue: buildQueueSummary(items),
  };

  const preflightPath = path.join(store, "cycles", identity.id, "preflight.json");
  await writeJson(preflightPath, preflight);
  const sha256 = await hashFile(preflightPath);
  const relPath = path.relative(root, preflightPath) || preflightPath;
  return {
    cycle_id: identity.id,
    cycle_index: identity.index,
    path: relPath.replace(/\\/g, "/"),
    sha256,
    preflight,
  };
};
