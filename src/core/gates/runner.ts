import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { triageGateOutput, type TriageSummary } from "../logs/triage.js";
import { resolveAdapter } from "../adapters/registry.js";
import { resolveGateConfig, type GateOverrideState } from "./overrides.js";
import { normalizeHoldoutGateId, resolveHoldoutTasks } from "../blocks/holdout.js";
import type { CoreAdapter } from "../adapters/types.js";

export type GateCommand = {
  id: string;
  cmd?: string[];
  command?: string[];
  cwd?: string;
  kind?: "holdout";
  timeoutMs?: number;
};

type GateScopeMapEntry = {
  prefix: string;
  scope: string;
};

type GateTestsConfig = {
  scopes?: Record<string, GateCommand[]>;
  order?: string[];
  root?: GateCommand[];
};

type GatesConfig = {
  scopeMap?: GateScopeMapEntry[];
  fast?: GateCommand[];
  full?: { tests?: GateTestsConfig };
};

export type GatePlan = {
  mode: string;
  reason: string;
  scopes: string[];
  gates: GateCommand[];
};

type GatePreflight = {
  port_permission: "allowed" | "blocked" | "unknown";
  warning: string | null;
  error: { code: string; message: string } | null;
};

type GateSkipReason = "no-browser";

type GateProgressEvent =
  | {
      type: "step_start";
      id: string;
      command: string;
      started_at: string;
    }
  | {
      type: "step_end";
      id: string;
      command: string;
      ok: boolean;
      exitCode: number;
      durationMs: number;
      ended_at: string;
    }
  | {
      type: "heartbeat";
      id: string;
      command: string;
    };

type GateProgressOptions = {
  onEvent: (event: GateProgressEvent) => void;
  heartbeatMs?: number;
  heartbeatTicks?: number;
};

const diffFiles = (before: string[], after: string[]): string[] => {
  const beforeSet = new Set(before);
  const touched = after.filter((entry) => !beforeSet.has(entry));
  touched.sort((a, b) => a.localeCompare(b));
  return touched;
};

const filterTouchedFiles = (files: string[]): string[] =>
  files.filter((entry) => !entry.startsWith(".ato/"));

const nowIso = (): string => new Date().toISOString();

const BROWSER_HINTS = [
  "browser",
  "playwright",
  "puppeteer",
  "cypress",
  "chromium",
  "webdriver",
  "selenium",
  "storybook",
];

const isBrowserGate = (gate: GateCommand, cmd: string[]): boolean => {
  const id = gate.id.toLowerCase();
  if (BROWSER_HINTS.some((hint) => id.includes(hint))) {
    return true;
  }
  const commandLine = cmd.join(" ").toLowerCase();
  return BROWSER_HINTS.some((hint) => commandLine.includes(hint));
};

const startHeartbeat = (
  progress: GateProgressOptions | null,
  info: { id: string; command: string },
): (() => void) => {
  if (!progress) return () => undefined;
  const { onEvent, heartbeatMs, heartbeatTicks } = progress;
  if (heartbeatTicks && heartbeatTicks > 0) {
    for (let i = 0; i < heartbeatTicks; i += 1) {
      onEvent({ type: "heartbeat", ...info });
    }
    return () => undefined;
  }
  if (!heartbeatMs || heartbeatMs <= 0) return () => undefined;
  const handle = setInterval(() => {
    onEvent({ type: "heartbeat", ...info });
  }, heartbeatMs);
  return () => clearInterval(handle);
};

const normalizePortPermission = (value: string | undefined): string => {
  return String(value ?? "").trim().toLowerCase();
};

const checkPortPermission = async (
  env?: NodeJS.ProcessEnv,
): Promise<GatePreflight> => {
  const override = normalizePortPermission(
    env?.["ATO_GATE_PORT_PERMISSION"] ?? env?.["ATO_PORT_PERMISSION"],
  );
  if (override === "allowed") {
    return { port_permission: "allowed", warning: null, error: null };
  }
  if (override === "blocked") {
    return {
      port_permission: "blocked",
      warning:
        "Port binding appears blocked (EPERM). Browser tests may fail; rerun with escalation or a no-browser option if available.",
      error: { code: "EPERM", message: "Port binding blocked by override." },
    };
  }
  if (override === "unknown") {
    return { port_permission: "unknown", warning: null, error: null };
  }

  return await new Promise((resolve) => {
    const server = net.createServer();
    const finalize = (result: GatePreflight) => {
      server.removeAllListeners();
      resolve(result);
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "UNKNOWN";
      if (code === "EACCES" || code === "EPERM") {
        finalize({
          port_permission: "blocked",
          warning:
            `Port binding appears blocked (${code}). Browser tests may fail; rerun with escalation or a no-browser option if available.`,
          error: { code, message: err.message ?? "Port binding blocked." },
        });
      } else {
        finalize({
          port_permission: "unknown",
          warning: null,
          error: { code: String(code), message: err.message ?? "Port error." },
        });
      }
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => {
        finalize({ port_permission: "allowed", warning: null, error: null });
      });
    });
  });
};

const readChangedFiles = async (root: string): Promise<string[]> => {
  return new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: root });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const files: string[] = [];
      for (const line of lines) {
        const raw = line.slice(3).trim();
        if (!raw) continue;
        if (raw.includes(" -> ")) {
          const renamed = raw.split(" -> ").pop();
          if (renamed) files.push(renamed.trim());
        } else {
          files.push(raw);
        }
      }
      resolve(files);
    });
  });
};

const classifyScope = (
  filePath: string,
  scopeMap: GateScopeMapEntry[],
): string => {
  for (const entry of scopeMap) {
    if (filePath.startsWith(entry.prefix)) return entry.scope;
  }
  return "root";
};

const buildTestPlan = ({
  changedFiles,
  scopeMap,
  testsConfig,
}: {
  changedFiles: string[];
  scopeMap: GateScopeMapEntry[];
  testsConfig: GateTestsConfig;
}): GatePlan => {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { mode: "none", reason: "no-changes", scopes: [], gates: [] };
  }

  const scopes = new Set<string>();
  for (const filePath of changedFiles) {
    scopes.add(classifyScope(filePath, scopeMap));
  }

  if (scopes.size === 1 && scopes.has("internal")) {
    return {
      mode: "none",
      reason: "internal-only",
      scopes: ["internal"],
      gates: [],
    };
  }

  if (scopes.has("root")) {
    return {
      mode: "root",
      reason: "root-change",
      scopes: ["root"],
      gates: testsConfig.root ?? [],
    };
  }

  const gates: GateCommand[] = [];
  const order = testsConfig.order ?? [];
  for (const scope of order) {
    if (!scopes.has(scope)) continue;
    gates.push(...(testsConfig.scopes?.[scope] ?? []));
  }

  return {
    mode: "scoped",
    reason: "scoped",
    scopes: [...scopes].sort(),
    gates,
  };
};

const uniqueGateCommands = (gates: GateCommand[]): GateCommand[] => {
  const seen = new Set<string>();
  const output: GateCommand[] = [];
  for (const gate of gates) {
    if (!gate?.id || seen.has(gate.id)) continue;
    seen.add(gate.id);
    output.push(gate);
  }
  return output;
};

const listScopeOrder = (testsConfig: GateTestsConfig): string[] => {
  const order = testsConfig.order ?? [];
  const scopes = testsConfig.scopes ?? {};
  const remaining = Object.keys(scopes).filter((scope) => !order.includes(scope));
  remaining.sort();
  return [...order, ...remaining];
};

const listFullGates = (testsConfig: GateTestsConfig): GateCommand[] => {
  const gates: GateCommand[] = [];
  const root = testsConfig.root ?? [];
  gates.push(...root);
  const scopes = testsConfig.scopes ?? {};
  const scopeOrder = listScopeOrder(testsConfig);
  for (const scope of scopeOrder) {
    gates.push(...(scopes[scope] ?? []));
  }
  return uniqueGateCommands(gates);
};

const resolveStorePath = (
  root: string,
  config: { storeDir?: string },
): string => path.resolve(root, config.storeDir ?? ".ato");

const loadHoldoutGates = async ({
  root,
  config,
  blockId,
}: {
  root: string;
  config: { storeDir?: string };
  blockId?: string | null;
}): Promise<GateCommand[]> => {
  const store = resolveStorePath(root, config);
  const tasks = await resolveHoldoutTasks(
    blockId ? { store, blockId } : { store },
  );
  return tasks.map((task) => ({
    id: normalizeHoldoutGateId(task.id),
    cmd: task.cmd,
    kind: "holdout",
  }));
};

export const listGateCommands = async ({
  config,
  mode,
  root,
  blockId,
}: {
  config: { gates?: GatesConfig; storeDir?: string };
  mode: string;
  root?: string;
  blockId?: string | null;
}): Promise<{ gates: GateCommand[]; plan: GatePlan }> => {
  const gatesConfig = config.gates ?? {};
  const fastGates = uniqueGateCommands(gatesConfig.fast ?? []);
  if (mode === "fast") {
    return {
      gates: fastGates,
      plan: { mode: "fast-only", reason: "manual", scopes: [], gates: [] },
    };
  }

  const testsConfig = gatesConfig.full?.tests ?? { scopes: {}, order: [] };
  const fullGates = listFullGates(testsConfig);
  const scopes = listScopeOrder(testsConfig);
  const holdoutGates =
    mode === "full" && root
      ? await loadHoldoutGates({
          root,
          config,
          ...(blockId ? { blockId } : {}),
        })
      : [];
  const planGates = uniqueGateCommands([...fullGates, ...holdoutGates]);
  const plan: GatePlan = {
    mode: "full-all",
    reason: "manual",
    scopes: scopes.length ? scopes : [],
    gates: planGates,
  };
  return {
    gates: uniqueGateCommands([...fastGates, ...fullGates, ...holdoutGates]),
    plan,
  };
};

export const buildGatePlan = async ({
  root,
  config,
  mode,
  blockId,
}: {
  root: string;
  config: { gates?: GatesConfig; storeDir?: string };
  mode: string;
  blockId?: string | null;
}): Promise<{ gates: GateCommand[]; plan: GatePlan }> => {
  const gatesConfig = config.gates ?? {};
  const scopeMap = gatesConfig.scopeMap ?? [];
  const fastGates = gatesConfig.fast ?? [];
  if (mode === "fast") {
    return {
      gates: fastGates,
      plan: { mode: "fast-only", reason: "fast", scopes: [], gates: [] },
    };
  }

  const changedFiles = await readChangedFiles(root);
  const testsConfig = gatesConfig.full?.tests ?? { scopes: {}, order: [] };
  const plan = buildTestPlan({ changedFiles, scopeMap, testsConfig });
  const holdoutGates = await loadHoldoutGates({
    root,
    config,
    ...(blockId ? { blockId } : {}),
  });
  const fullPlan = {
    ...plan,
    gates: uniqueGateCommands([...plan.gates, ...holdoutGates]),
  };
  const gates = uniqueGateCommands([...fastGates, ...plan.gates, ...holdoutGates]);
  return { gates, plan: fullPlan };
};

const runGatePlan = async ({
  adapter,
  overrides,
  root,
  targetId,
  queueId,
  mode,
  plan,
  gates,
  artifactsDir,
  env,
  progress,
  noBrowser,
}: {
  adapter: CoreAdapter;
  overrides: GateOverrideState | null;
  root: string;
  targetId: string;
  queueId: string | null;
  mode: string;
  plan: GatePlan;
  gates: GateCommand[];
  artifactsDir: string | null;
  env?: NodeJS.ProcessEnv;
  progress?: GateProgressOptions;
  noBrowser?: boolean;
}): Promise<{
  ok: boolean;
  results: Array<{
    id: string;
    command: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    started_at: string;
    ended_at: string;
    status: "ok" | "fail" | "skipped";
    skip_reason?: GateSkipReason;
    touched_files: string[];
    artifact: string | null;
    triage: TriageSummary | null;
  }>;
  artifacts: string[];
  plan: GatePlan;
  mode: string;
  targetId: string;
  queueId: string | null;
  totalDurationMs: number;
  preflight: GatePreflight | null;
  overrides: GateOverrideState | null;
}> => {
  const preflight = mode === "full" ? await checkPortPermission(env) : null;
  const results: Array<{
    id: string;
    command: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    started_at: string;
    ended_at: string;
    status: "ok" | "fail" | "skipped";
    skip_reason?: GateSkipReason;
    touched_files: string[];
    artifact: string | null;
    triage: TriageSummary | null;
  }> = [];
  const artifacts: string[] = [];

  const holdoutIds = new Set(
    gates.filter((gate) => gate.kind === "holdout").map((gate) => gate.id),
  );
  let failure = false;

  for (const gate of gates) {
    const isHoldout = holdoutIds.has(gate.id);
    if (failure && !isHoldout) continue;
    const cwd = gate.cwd ? path.resolve(root, gate.cwd) : root;
    const cmd = gate.cmd ?? gate.command;
    if (!cmd) {
      const started_at = nowIso();
      const ended_at = nowIso();
      results.push({
        id: gate.id,
        command: "",
        ok: false,
        exitCode: 1,
        durationMs: 0,
        started_at,
        ended_at,
        status: "fail",
        touched_files: [],
        artifact: null,
        triage: null,
      });
      failure = true;
      continue;
    }
    const shouldSkipBrowser = Boolean(noBrowser && isBrowserGate(gate, cmd));
    const commandLine = cmd.join(" ");
    const started_at = nowIso();
    if (shouldSkipBrowser) {
      results.push({
        id: gate.id,
        command: commandLine,
        ok: true,
        exitCode: 0,
        durationMs: 0,
        started_at,
        ended_at: started_at,
        status: "skipped",
        skip_reason: "no-browser",
        touched_files: [],
        artifact: null,
        triage: null,
      });
      continue;
    }
    const progressHandler = progress ?? null;
    if (progressHandler) {
      progressHandler.onEvent({
        type: "step_start",
        id: gate.id,
        command: commandLine,
        started_at,
      });
    }
    const stopHeartbeat = startHeartbeat(progressHandler, {
      id: gate.id,
      command: commandLine,
    });
    const beforeFiles = await readChangedFiles(root);
    const stream = progressHandler
      ? { stdout: process.stdout, stderr: process.stderr }
      : null;
    const timeoutMs =
      typeof gate.timeoutMs === "number" && Number.isFinite(gate.timeoutMs)
        ? Math.max(0, Math.floor(gate.timeoutMs))
        : undefined;
    const result = await adapter.executeStep({
      cmd,
      cwd,
      ...(env ? { env } : {}),
      ...(stream ? { stream } : {}),
      artifact: artifactsDir ? { dir: artifactsDir, gateId: gate.id } : null,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    stopHeartbeat();
    const ended_at = nowIso();
    const afterFiles = await readChangedFiles(root);
    const touchedFiles = filterTouchedFiles(diffFiles(beforeFiles, afterFiles));

    const artifactPath = result.artifactPath ?? null;
    if (artifactPath) {
      artifacts.push(artifactPath);
    }

    const triage = triageGateOutput({
      id: gate.id,
      command: result.commandLine,
      stdout: result.stdout,
      stderr: result.stderr,
    });

    results.push({
      id: gate.id,
      command: result.commandLine,
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      started_at,
      ended_at,
      status: result.ok ? "ok" : "fail",
      touched_files: touchedFiles,
      artifact: artifactPath,
      triage,
    });
    if (progressHandler) {
      progressHandler.onEvent({
        type: "step_end",
        id: gate.id,
        command: result.commandLine,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ended_at,
      });
    }

    if (!result.ok) {
      failure = true;
    }
  }

  const ok = results.every((result) => result.ok);
  const totalDurationMs = results.reduce((sum, result) => {
    const duration = Number.isFinite(result.durationMs) ? result.durationMs : 0;
    return sum + duration;
  }, 0);
  return {
    ok,
    results,
    artifacts,
    plan,
    mode,
    targetId,
    queueId,
    totalDurationMs,
    preflight,
    overrides,
  };
};

export const runGates = async ({
  root,
  targetId,
  queueId,
  mode,
  config,
  artifactsDir,
  env,
  progress,
  noBrowser,
  adapter,
  blockId,
}: {
  root: string;
  targetId: string;
  queueId: string | null;
  mode: string;
  config: { gates?: GatesConfig; storeDir?: string };
  artifactsDir: string | null;
  env?: NodeJS.ProcessEnv;
  progress?: GateProgressOptions;
  noBrowser?: boolean;
  adapter?: CoreAdapter;
  blockId?: string | null;
}): Promise<{
  ok: boolean;
  results: Array<{
    id: string;
    command: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    started_at: string;
    ended_at: string;
    status: "ok" | "fail" | "skipped";
    skip_reason?: GateSkipReason;
    touched_files: string[];
    artifact: string | null;
    triage: TriageSummary | null;
  }>;
  artifacts: string[];
  plan: GatePlan;
  mode: string;
  targetId: string;
  queueId: string | null;
  totalDurationMs: number;
  preflight: GatePreflight | null;
  overrides: GateOverrideState | null;
}> => {
  const resolvedAdapter = adapter ?? resolveAdapter();
  const resolvedConfig = resolveGateConfig({ config, targetId });
  const { gates, plan } = await buildGatePlan({
    root,
    config: { gates: resolvedConfig.effective },
    mode,
    ...(blockId ? { blockId } : {}),
  });
  const args = {
    adapter: resolvedAdapter,
    overrides: resolvedConfig.overrides,
    root,
    targetId,
    queueId,
    mode,
    plan,
    gates,
    artifactsDir,
    ...(env ? { env } : {}),
    ...(progress ? { progress } : {}),
    ...(noBrowser ? { noBrowser } : {}),
  };
  return runGatePlan(args);
};

export const runGateSelection = async ({
  root,
  targetId,
  queueId,
  mode,
  plan,
  gates,
  artifactsDir,
  env,
  progress,
  noBrowser,
  adapter,
  overrides,
}: {
  root: string;
  targetId: string;
  queueId: string | null;
  mode: string;
  plan: GatePlan;
  gates: GateCommand[];
  artifactsDir: string | null;
  env?: NodeJS.ProcessEnv;
  progress?: GateProgressOptions;
  noBrowser?: boolean;
  adapter?: CoreAdapter;
  overrides?: GateOverrideState | null;
}): Promise<{
  ok: boolean;
  results: Array<{
    id: string;
    command: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    started_at: string;
    ended_at: string;
    status: "ok" | "fail" | "skipped";
    skip_reason?: GateSkipReason;
    touched_files: string[];
    artifact: string | null;
    triage: TriageSummary | null;
  }>;
  artifacts: string[];
  plan: GatePlan;
  mode: string;
  targetId: string;
  queueId: string | null;
  totalDurationMs: number;
  preflight: GatePreflight | null;
  overrides: GateOverrideState | null;
}> => {
  const resolvedAdapter = adapter ?? resolveAdapter();
  const args = {
    adapter: resolvedAdapter,
    overrides: overrides ?? null,
    root,
    targetId,
    queueId,
    mode,
    plan,
    gates,
    artifactsDir,
    ...(env ? { env } : {}),
    ...(progress ? { progress } : {}),
    ...(noBrowser ? { noBrowser } : {}),
  };
  return runGatePlan(args);
};
