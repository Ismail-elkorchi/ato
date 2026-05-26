import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findProtectedBlockChanges } from "./blocks/immutability.js";

export const PROTOCOL_VERSION = 1;

const parseVersion = (value: unknown): number[] => {
  const parts = String(value ?? "")
    .split(".")
    .map((part) => Number(part));
  return parts.length ? parts : [0];
};

export const compareVersions = (a: unknown, b: unknown): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
};

export const getCliVersion = async (): Promise<string> => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(moduleDir, "../../package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
};

export const readAgentsMetadata = async (
  root: string,
): Promise<{
  agentsPath: string;
  meta: { protocolVersion?: number; minCliVersion?: string };
}> => {
  const agentsPath = path.join(root, "AGENTS.md");
  const raw = await fs.readFile(agentsPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const meta: { protocolVersion?: number; minCliVersion?: string } = {};
  for (const line of lines) {
    const versionMatch = line.match(/ATO_PROTOCOL_VERSION:\s*(\d+)/);
    if (versionMatch) {
      meta.protocolVersion = Number(versionMatch[1]);
    }
    const minMatch = line.match(/ATO_MIN_CLI_VERSION:\s*([0-9.]+)/);
    if (minMatch) {
      const value = minMatch[1];
      if (value) {
        meta.minCliVersion = value;
      }
    }
  }
  return { agentsPath, meta };
};

export const checkProtocolCompatibility = async (
  root: string,
): Promise<{
  ok: boolean;
  agentsPath: string;
  meta: { protocolVersion: number | null; minCliVersion: string | null; cliVersion: string };
  errors: Array<{ kind: string; message: string }>;
}> => {
  const cliVersion = await getCliVersion();
  const { agentsPath, meta } = await readAgentsMetadata(root);

  const protocolVersion = meta.protocolVersion ?? null;
  const minCliVersion = meta.minCliVersion ?? null;

  const errors: Array<{ kind: string; message: string }> = [];
  if (protocolVersion !== PROTOCOL_VERSION) {
    errors.push({
      kind: "protocol_mismatch",
      message: `Protocol version mismatch. Repo=${protocolVersion} CLI=${PROTOCOL_VERSION}`,
    });
  }

  if (minCliVersion && compareVersions(cliVersion, minCliVersion) < 0) {
    errors.push({
      kind: "cli_too_old",
      message: `CLI ${cliVersion} is below min required ${minCliVersion}.`,
    });
  }

  const { changes, error } = await findProtectedBlockChanges({ root });
  if (error) {
    errors.push({
      kind: "git_diff_failed",
      message: error,
    });
  }
  for (const change of changes) {
    errors.push({
      kind: "protected_block_modified",
      message: `${change.path} (${change.reason})`,
    });
  }

  return {
    ok: errors.length === 0,
    agentsPath,
    meta: {
      protocolVersion,
      minCliVersion,
      cliVersion,
    },
    errors,
  };
};
