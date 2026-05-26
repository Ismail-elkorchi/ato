import path from "node:path";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import { resolveTarget } from "../../core/targets/resolve.js";
import { checkProtocolCompatibility } from "../../core/protocol.js";
import { acquireLock, releaseLock } from "../../core/lock.js";
import { ensureDir, readJson } from "../../core/fs.js";
import type { CommandContext } from "../types.js";
import type { TargetContext } from "../../core/types.js";

type CheckSeverity = "ok" | "warn" | "fail";
type DiagnoseCheck = {
  id: string;
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  message: string;
  details?: unknown;
};

const HELP = [
  "Usage: ato diagnose [options]",
  "",
  "Options:",
  "  --json    Emit machine-readable JSON",
  "",
  "Example:",
  "  ato diagnose --json",
].join("\n");

const parseVersion = (value: string | null): number[] | null => {
  if (!value) return null;
  const match = value.match(/(\\d+\\.\\d+\\.\\d+)/);
  const version = match?.[1];
  if (!version) return null;
  return version.split(".").map((part) => Number(part));
};

const compareVersions = (left: number[], right: number[]): number => {
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
};

const resolveTargetSafe = async ({
  context,
}: {
  context: CommandContext;
}): Promise<{
  target: TargetContext | null;
  error: string | null;
  details?: unknown;
}> => {
  const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
  const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
  try {
    const { target } = await resolveTarget({
      cwd: process.cwd(),
      selection,
      storeSelection,
      requireWrite: false,
    });
    return { target, error: null };
  } catch (error) {
    const err = error as Error & { details?: unknown };
    return {
      target: null,
      error: err.message ?? String(error),
      details: err.details,
    };
  }
};

const checkNodeVersion = async (
  root: string | null,
): Promise<DiagnoseCheck> => {
  const packagePath = path.join(root ?? process.cwd(), "package.json");
  const pkg = await readJson<Record<string, unknown>>(packagePath, null);
  const engines = (pkg?.["engines"] as Record<string, string> | undefined) ?? {};
  const required = engines["node"] ?? null;
  const requiredVersion = parseVersion(required);
  const current = parseVersion(process.versions.node);
  if (!requiredVersion || !current) {
    return {
      id: "node",
      label: "Node version",
      ok: false,
      severity: "warn",
      message: `Unable to parse required node version (${required ?? "missing"}).`,
      details: { required, current: process.versions.node },
    };
  }
  const ok = compareVersions(current, requiredVersion) >= 0;
  return {
    id: "node",
    label: "Node version",
    ok,
    severity: ok ? "ok" : "fail",
    message: `current ${process.versions.node} required ${required}`,
    details: { required, current: process.versions.node },
  };
};

const checkProtocol = async (target: TargetContext): Promise<DiagnoseCheck> => {
  const result = await checkProtocolCompatibility(target.root);
  return {
    id: "protocol",
    label: "Protocol check",
    ok: result.ok,
    severity: result.ok ? "ok" : "fail",
    message: result.ok
      ? `protocol ${result.meta.protocolVersion} cli ${result.meta.cliVersion}`
      : "Protocol compatibility check failed.",
    details: result,
  };
};

const checkLock = async (target: TargetContext): Promise<DiagnoseCheck> => {
  await ensureDir(target.storePath);
  const lock = await acquireLock(target.storePath, target.config.lock?.ttlMs);
  if (lock.ok) {
    await releaseLock(lock.lockPath);
    return {
      id: "lock",
      label: "Write lock",
      ok: true,
      severity: "ok",
      message: "Lock is available.",
      details: { lockPath: lock.lockPath },
    };
  }
  return {
    id: "lock",
    label: "Write lock",
    ok: false,
    severity: "warn",
    message: "Lock is held by another process.",
    details: { lockPath: lock.lockPath, current: lock.current },
  };
};

const checkGates = (target: TargetContext): DiagnoseCheck => {
  const gates = target.config.gates ?? {};
  const fast = gates.fast ?? [];
  const fullRoot = gates.full?.tests?.root ?? [];
  const fullScopes = gates.full?.tests?.scopes ?? {};
  const fullScopeCount = Object.values(fullScopes).reduce(
    (total, list) => total + (list?.length ?? 0),
    0,
  );
  const fullCount = fullRoot.length + fullScopeCount;
  const ok = fast.length > 0 && fullCount > 0;
  const severity: CheckSeverity = ok ? "ok" : "warn";
  const message = ok
    ? "Fast/full gate commands configured."
    : "Gate commands missing or incomplete.";
  return {
    id: "gates",
    label: "Gate availability",
    ok,
    severity,
    message,
    details: {
      fast: fast.length,
      full: fullCount,
      fullRoot: fullRoot.length,
      fullScopes: fullScopeCount,
    },
  };
};

export const runDiagnoseCommand = async ({
  args,
  context,
}: {
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { flags, positionals } = parseFlags(args);
  if (flags["help"] || positionals.length) {
    writeLines([HELP]);
    return;
  }

  const { target, error, details } = await resolveTargetSafe({ context });
  const checks: DiagnoseCheck[] = [];
  checks.push(await checkNodeVersion(target?.root ?? null));

  if (target) {
    checks.push({
      id: "repo",
      label: "Repo resolve",
      ok: true,
      severity: "ok",
      message: `repo ${target.id}`,
      details: { id: target.id, root: target.root, store: target.storePath },
    });
    checks.push(await checkProtocol(target));
    checks.push(await checkLock(target));
    checks.push(checkGates(target));
  } else {
    checks.push({
      id: "repo",
      label: "Repo resolve",
      ok: false,
      severity: "fail",
      message: error ?? "Repo resolution failed.",
      details,
    });
    checks.push({
      id: "protocol",
      label: "Protocol check",
      ok: false,
      severity: "fail",
      message: "Skipped (repo unresolved).",
    });
    checks.push({
      id: "lock",
      label: "Write lock",
      ok: false,
      severity: "warn",
      message: "Skipped (repo unresolved).",
    });
    checks.push({
      id: "gates",
      label: "Gate availability",
      ok: false,
      severity: "warn",
      message: "Skipped (repo unresolved).",
    });
  }

  const packagePath = path.join(target?.root ?? process.cwd(), "package.json");
  const pkg = await readJson<Record<string, unknown>>(packagePath, null);
  const cliVersion = (pkg?.["version"] as string | undefined) ?? "unknown";
  const protocolResult = target ? await checkProtocolCompatibility(target.root) : null;

  const ok = checks.every((check) => check.severity !== "fail");
  if (context.json) {
    writeJson({
      ok,
      checks,
      meta: {
        cliVersion,
        nodeVersion: process.versions.node,
        protocol: protocolResult?.meta ?? null,
        repo: target
          ? {
              id: target.id,
              root: target.root,
              store: target.storePath,
              fingerprint: target.fingerprint,
            }
          : null,
      },
    });
    return;
  }

  const lines = [
    "diagnose",
    `cli version: ${cliVersion}`,
    `node version: ${process.versions.node}`,
  ];
  if (protocolResult?.meta) {
    lines.push(`protocol version: ${protocolResult.meta.protocolVersion}`);
  }
  if (target) {
    lines.push(`repo: ${target.id} root: ${target.root}`);
  }
  lines.push("");
  for (const check of checks) {
    const status = check.ok ? "ok" : check.severity;
    lines.push(`${check.label}: ${status} — ${check.message}`);
  }
  writeLines(lines);
};
