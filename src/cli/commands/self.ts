import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { ensureDir, fileExists, readJson } from "../../core/fs.js";
import type { CommandContext } from "../types.js";
import type { RunLogEntry } from "../../core/types.js";

type CommandResult = {
  id: string;
  cmd: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
};

const HELP = [
  "Usage: ato self update|rollback [options]",
  "",
  "Options:",
  "  --dry-run   Print planned steps without installing",
  "",
  "Examples:",
  "  ato self update --dry-run",
  "  ato self rollback",
].join("\n");

const runCommand = async ({
  id,
  cmd,
  cwd,
  env,
}: {
  id: string;
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> => {
  const [bin, ...args] = cmd;
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin ?? "", args, { cwd, env });
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
        id,
        cmd,
        cwd,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        stdout,
        stderr,
      });
    });
  });
};

const hashFile = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const readPackageInfo = async (root: string) => {
  const pkg = await readJson<Record<string, unknown>>(
    path.join(root, "package.json"),
    null,
  );
  return {
    name: (pkg?.["name"] as string | undefined) ?? "ato",
    version: (pkg?.["version"] as string | undefined) ?? "0.0.0",
  };
};

const parsePackOutput = (stdout: string): string | null => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? null;
};

const writeProvenance = async ({
  artifactsDir,
  record,
}: {
  artifactsDir: string;
  record: Record<string, unknown>;
}): Promise<string> => {
  await ensureDir(artifactsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recordPath = path.join(artifactsDir, `self-update-${timestamp}.json`);
  const latestPath = path.join(artifactsDir, "self-update-latest.json");
  const payload = JSON.stringify(record, null, 2);
  await fs.writeFile(recordPath, payload);
  await fs.writeFile(latestPath, payload);
  return recordPath;
};

const resolveGlobalRoot = async (): Promise<string> => {
  const result = await runCommand({
    id: "npm-root",
    cmd: ["npm", "root", "-g"],
    cwd: process.cwd(),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve global npm root: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const resolveInstalledPackage = async (pkgName: string) => {
  const root = await resolveGlobalRoot();
  const installPath = path.join(root, pkgName);
  if (!(await fileExists(installPath))) {
    return { installPath, version: null };
  }
  const pkg = await readJson<Record<string, unknown>>(
    path.join(installPath, "package.json"),
    null,
  );
  return {
    installPath,
    version: (pkg?.["version"] as string | undefined) ?? null,
  };
};

const cmdUpdate = async ({
  context,
  dryRun,
}: {
  context: CommandContext;
  dryRun: boolean;
}): Promise<void> => {
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const pkg = await readPackageInfo(target.root);
    const artifactsDir = getArtifactsDir(target.storePath, null, "self-update");
    const buildStep = { id: "build", cmd: ["npm", "run", "build"], cwd: target.root };
    const testStep = { id: "test", cmd: ["npm", "run", "test"], cwd: target.root };
    const packStep = {
      id: "pack",
      cmd: ["npm", "pack", "--pack-destination", artifactsDir],
      cwd: target.root,
    };
    const installStep = {
      id: "install",
      cmd: ["npm", "install", "-g", "<tarball>"],
      cwd: target.root,
    };
    const verifyStep = {
      id: "verify",
      cmd: ["npm", "list", "-g", pkg.name, "--json"],
      cwd: target.root,
    };
    const plan = [buildStep, testStep, packStep, installStep, verifyStep];

    if (dryRun) {
      const payload = { ok: true, dry_run: true, plan };
      if (context.json) {
        writeJson(payload);
      } else {
        writeLines([
          "self update (dry-run)",
          `package: ${pkg.name}@${pkg.version}`,
          "steps:",
          ...plan.map((step) => `- ${step.id}: ${step.cmd.join(" ")}`),
        ]);
      }
      return;
    }

    const installed = await resolveInstalledPackage(pkg.name);
    let backupTarball: string | null = null;
    if (await fileExists(installed.installPath)) {
      const backupPack = await runCommand({
        id: "backup-pack",
        cmd: ["npm", "pack", "--pack-destination", artifactsDir],
        cwd: installed.installPath,
      });
      if (backupPack.exitCode !== 0) {
        throw new Error(`Backup pack failed: ${backupPack.stderr}`);
      }
      const backupName = parsePackOutput(backupPack.stdout);
      if (backupName) {
        backupTarball = path.join(artifactsDir, backupName);
      }
    }

    const commands: CommandResult[] = [];
    for (const step of [buildStep, testStep]) {
      const result = await runCommand(step);
      commands.push(result);
      if (result.exitCode !== 0) {
        throw new Error(`${step.id} failed: ${result.stderr}`);
      }
    }

    const packResult = await runCommand(packStep);
    commands.push(packResult);
    if (packResult.exitCode !== 0) {
      throw new Error(`pack failed: ${packResult.stderr}`);
    }
    const packName = parsePackOutput(packResult.stdout);
    if (!packName) {
      throw new Error("Unable to determine packed tarball name.");
    }
    const tarballPath = path.join(artifactsDir, packName);
    const buildHash = await hashFile(tarballPath);

    const installResult = await runCommand({
      ...installStep,
      cmd: ["npm", "install", "-g", tarballPath],
    });
    commands.push(installResult);
    if (installResult.exitCode !== 0) {
      throw new Error(`install failed: ${installResult.stderr}`);
    }

    const verifyResult = await runCommand(verifyStep);
    commands.push(verifyResult);
    if (verifyResult.exitCode !== 0) {
      throw new Error(`verify failed: ${verifyResult.stderr}`);
    }
    const parsed = JSON.parse(verifyResult.stdout || "{}");
    const installedVersion =
      parsed?.dependencies?.[pkg.name]?.version ?? null;
    if (installedVersion !== pkg.version) {
      throw new Error(
        `Version mismatch after install. Expected ${pkg.version}, got ${installedVersion ?? "unknown"}.`,
      );
    }

    const provenance = {
      ts: new Date().toISOString(),
      package: pkg.name,
      previousVersion: installed.version,
      nextVersion: pkg.version,
      buildHash,
      backupTarball,
      tarballPath,
      commands: commands.map((entry) => ({
        id: entry.id,
        cmd: entry.cmd.join(" "),
        cwd: entry.cwd,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
      })),
    };
    const provenancePath = await writeProvenance({
      artifactsDir,
      record: provenance,
    });

    const runEntry: RunLogEntry = {
      ts: provenance.ts,
      kind: "self_update",
      target_id: target.id,
      commands: commands.map((entry) => ({
        cmd: entry.cmd.join(" "),
        cwd: entry.cwd,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
      })),
      artifacts: [provenancePath, tarballPath, backupTarball].filter(
        (value): value is string => Boolean(value),
      ),
      summary: `self update ${pkg.version}`,
    };
    await appendRunLog(target.storePath, runEntry);

    if (context.json) {
      writeJson({ ok: true, version: pkg.version, buildHash });
    } else {
      writeLines([
        `self update: ${pkg.name}@${pkg.version}`,
        `build hash: ${buildHash}`,
        `backup: ${backupTarball ?? "none"}`,
      ]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};

const cmdRollback = async ({
  context,
}: {
  context: CommandContext;
}): Promise<void> => {
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

  try {
    const pkg = await readPackageInfo(target.root);
    const artifactsDir = getArtifactsDir(target.storePath, null, "self-update");
    const latestPath = path.join(artifactsDir, "self-update-latest.json");
    const latest = await readJson<Record<string, unknown>>(latestPath, null);
    const backupTarball = (latest?.["backupTarball"] as string | undefined) ?? null;
    const previousVersion =
      (latest?.["previousVersion"] as string | undefined) ?? null;
    if (!backupTarball) {
      throw new Error("No backup tarball found to rollback.");
    }

    const commands: CommandResult[] = [];
    const installResult = await runCommand({
      id: "rollback-install",
      cmd: ["npm", "install", "-g", backupTarball],
      cwd: target.root,
    });
    commands.push(installResult);
    if (installResult.exitCode !== 0) {
      throw new Error(`rollback install failed: ${installResult.stderr}`);
    }

    const verifyResult = await runCommand({
      id: "rollback-verify",
      cmd: ["npm", "list", "-g", pkg.name, "--json"],
      cwd: target.root,
    });
    commands.push(verifyResult);
    if (verifyResult.exitCode !== 0) {
      throw new Error(`rollback verify failed: ${verifyResult.stderr}`);
    }
    const parsed = JSON.parse(verifyResult.stdout || "{}");
    const installedVersion =
      parsed?.dependencies?.[pkg.name]?.version ?? null;
    if (previousVersion && installedVersion !== previousVersion) {
      throw new Error(
        `Version mismatch after rollback. Expected ${previousVersion}, got ${installedVersion ?? "unknown"}.`,
      );
    }

    const runEntry: RunLogEntry = {
      ts: new Date().toISOString(),
      kind: "self_rollback",
      target_id: target.id,
      commands: commands.map((entry) => ({
        cmd: entry.cmd.join(" "),
        cwd: entry.cwd,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
      })),
      artifacts: [latestPath, backupTarball],
      summary: `self rollback ${previousVersion ?? "unknown"}`,
    };
    await appendRunLog(target.storePath, runEntry);

    if (context.json) {
      writeJson({ ok: true, version: installedVersion });
    } else {
      writeLines([
        `self rollback: ${pkg.name}`,
        `version: ${installedVersion ?? "unknown"}`,
      ]);
    }
  } finally {
    await releaseWriteLock(lockPath);
  }
};

export const runSelfCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand === "update") {
    await cmdUpdate({ context, dryRun: Boolean(flags["dry-run"]) });
    return;
  }

  if (subcommand === "rollback") {
    await cmdRollback({ context });
    return;
  }

  if (context.json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown self subcommand." },
    });
  } else {
    writeLines(["Unknown self subcommand.", HELP]);
  }
  process.exitCode = 1;
};
