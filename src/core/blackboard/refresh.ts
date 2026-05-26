import {
  readSignalDefinitionCatalog,
  validateSignalDefinitionCatalog,
} from "../signals/definitions.js";
import type { BlackboardSignal, SignalDefinitionCatalog } from "../types.js";

export type BlackboardObservation = {
  id?: string;
  signal?: string;
  cmd?: string[];
  cwd?: string;
};

export type NormalizedBlackboardObservation = {
  signal: string;
  cmd: string[];
  cwd?: string | null;
};

export type BlackboardCommandResult = {
  signal: string;
  commandLine: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  ok: boolean;
};

type CatalogLoadResult = {
  ok: boolean;
  catalog: SignalDefinitionCatalog;
  catalogPath: string;
  catalogSignals: string[];
  errors: string[];
};

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const normalizeSignalName = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const normalizeCmd = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => String(entry).trim()).filter(Boolean);
  return entries.length ? entries : null;
};

export const normalizeEvidence = (values: string[]): string[] => {
  const entries = values.map((value) => value.trim()).filter(Boolean);
  const unique = [...new Set(entries)];
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
};

export const sortBlackboardSignals = (
  signals: BlackboardSignal[],
): BlackboardSignal[] =>
  [...signals].sort((a, b) => {
    const kindA = a.kind ?? "";
    const kindB = b.kind ?? "";
    const kindDiff = kindA.localeCompare(kindB);
    if (kindDiff !== 0) return kindDiff;
    const summaryDiff = a.summary.localeCompare(b.summary);
    if (summaryDiff !== 0) return summaryDiff;
    const evidenceA = (a.evidence ?? []).join("|");
    const evidenceB = (b.evidence ?? []).join("|");
    return evidenceA.localeCompare(evidenceB);
  });

const buildCatalogSignals = (catalog: SignalDefinitionCatalog): {
  signals: string[];
  errors: string[];
} => {
  const errors: string[] = [];
  const seen = new Set<string>();
  const signals: string[] = [];
  for (const entry of catalog) {
    const name = normalizeSignalName(entry?.name);
    if (!name) {
      errors.push("Signal definition missing name.");
      continue;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate signal definition '${name}'.`);
      continue;
    }
    seen.add(name);
    signals.push(name);
  }
  signals.sort((a, b) => a.localeCompare(b));
  errors.sort((a, b) => a.localeCompare(b));
  return { signals, errors };
};

export const loadSignalCatalog = async (
  store: string,
): Promise<CatalogLoadResult> => {
  const { catalog, path: catalogPath } = await readSignalDefinitionCatalog(store);
  const validation = await validateSignalDefinitionCatalog(catalog);
  const catalogErrors = validation.errors.slice().sort((a, b) => a.localeCompare(b));
  const { signals, errors } = buildCatalogSignals(catalog);
  return {
    ok: validation.ok && errors.length === 0,
    catalog,
    catalogPath,
    catalogSignals: signals,
    errors: [...catalogErrors, ...errors],
  };
};

export const normalizeBlackboardObservations = ({
  observations,
  catalogSignals,
}: {
  observations: BlackboardObservation[];
  catalogSignals: string[];
}): { observations: NormalizedBlackboardObservation[]; errors: string[] } => {
  const errors: string[] = [];
  const normalized: NormalizedBlackboardObservation[] = [];
  const allowed = new Set(catalogSignals);
  const seen = new Set<string>();

  if (!Array.isArray(observations)) {
    return { observations: [], errors: ["Observations must be an array."] };
  }

  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object") {
      errors.push(`Observation ${index} must be an object.`);
      return;
    }
    const signal = normalizeSignalName(
      (observation as BlackboardObservation).signal ??
        (observation as BlackboardObservation).id,
    );
    if (!signal) {
      errors.push(`Observation ${index} missing signal name (set signal or id).`);
      return;
    }
    if (!allowed.has(signal)) {
      errors.push(
        `Unknown signal '${signal}'. Add it to .ato/signals/definitions.json.`,
      );
      return;
    }
    if (seen.has(signal)) {
      errors.push(`Duplicate observation for signal '${signal}'.`);
      return;
    }
    seen.add(signal);
    const cmd = normalizeCmd((observation as BlackboardObservation).cmd);
    if (!cmd) {
      errors.push(`Observation '${signal}' missing cmd array.`);
      return;
    }
    const cwd = normalizeSignalName((observation as BlackboardObservation).cwd);
    normalized.push({ signal, cmd, cwd: cwd || null });
  });

  errors.sort((a, b) => a.localeCompare(b));
  return { observations: normalized, errors };
};

export const buildBlackboardSignals = ({
  results,
  artifactRel,
  now,
}: {
  results: BlackboardCommandResult[];
  artifactRel: string;
  now: Date;
}): BlackboardSignal[] => {
  const artifact = toPosix(artifactRel);
  const ts = now.toISOString();
  const signals = results.map((result) => {
    const evidence = normalizeEvidence([
      `cmd:${result.commandLine}`,
      artifact ? `file:${artifact}` : "",
    ]);
    return {
      ts,
      kind: result.signal,
      summary: `${result.signal}: ${result.ok ? "ok" : "fail"}`,
      evidence,
    };
  });
  return sortBlackboardSignals(signals);
};

export const summarizeCommands = (results: BlackboardCommandResult[]) =>
  results.map((result) => ({
    signal: result.signal,
    cmd: result.commandLine,
    cwd: result.cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  }));

export const renderCommandLog = (results: BlackboardCommandResult[]): string =>
  results
    .map(
      (result) => `${result.signal}: ${result.commandLine} (${result.exitCode})`,
    )
    .join("\n");
