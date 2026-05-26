import crypto from "node:crypto";
import path from "node:path";

import { writeJson, writeLines } from "../utils.js";
import { resolveTarget, TargetError } from "../../core/targets/resolve.js";
import { readJson, writeJson as writeJsonFile } from "../../core/fs.js";
import { computeFingerprint } from "../../core/targets/fingerprint.js";
import type { CommandContext } from "../types.js";
import type { AtoConfig, TargetRegistry } from "../../core/types.js";

const toRelativePath = (root: string, filePath: string): string => {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" ? "." : relative;
};

const normalizePath = (root: string, value: string): string =>
  path.isAbsolute(value) ? toRelativePath(root, value) : value;

export const runRepoCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  void args;
  const json = context.json;

  if (subcommand === "resolve") {
    const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
    const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
    const { target } = await resolveTarget({
      cwd: process.cwd(),
      selection,
      storeSelection,
      requireWrite: false,
    });
    const rootRel = toRelativePath(target.root, target.root);
    const storeRel = toRelativePath(target.root, target.storePath);
    const configRel = toRelativePath(target.root, target.configPath);

    const payload = {
      ok: true,
      repo: {
        id: target.id,
        root: rootRel,
        store: storeRel,
        fingerprint: target.fingerprint,
        configPath: configRel,
      },
    };

    if (json) {
      writeJson(payload);
    } else {
      writeLines([
        `repo: ${target.id}`,
        `root: ${rootRel}`,
        `store: ${storeRel}`,
        `fingerprint: ${target.fingerprint}`,
      ]);
    }
    return;
  }

  if (subcommand === "list") {
    const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
    const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
    const { target } = await resolveTarget({
      cwd: process.cwd(),
      selection,
      storeSelection,
      requireWrite: false,
    });
    const root = target.root;
    const storePath = target.storePath;
    const registryPath = path.join(storePath, "targets.json");
    const registry = await readJson<TargetRegistry>(registryPath, null);
    const config = await readJson<AtoConfig>(path.join(storePath, "config.json"), null);
    const discovered = config?.targetId
      ? {
          id: config.targetId,
          root: toRelativePath(root, root),
          storeDir: config.storeDir ?? target.storeDir,
        }
      : null;

    const normalizedRegistry = (registry?.targets ?? []).map((entry) => ({
      ...entry,
      root: normalizePath(root, entry.root),
    }));
    const payload = {
      ok: true,
      registry: normalizedRegistry,
      discovered,
    };

    if (json) {
      writeJson(payload);
    } else {
      const lines = ["repos:"];
      for (const target of payload.registry) {
        lines.push(
          `- ${target.id}: root=${target.root} store=${target.storeDir ?? ".ato"}`,
        );
      }
      if (!payload.registry.length) {
        lines.push("- (none)");
      }
      lines.push("discovered:");
      if (payload.discovered) {
        lines.push(
          `- ${payload.discovered.id}: root=${payload.discovered.root}`,
        );
      } else {
        lines.push("- (none)");
      }
      writeLines(lines);
    }
    return;
  }

  if (subcommand === "init-seed") {
    const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
    const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
    const { target } = await resolveTarget({
      cwd: process.cwd(),
      selection,
      storeSelection,
      requireWrite: true,
      allowMissingSeed: true,
    });
    const root = target.root;
    const configPath = target.configPath;
    const config = await readJson<AtoConfig>(configPath, null);
    if (!config) {
      throw new TargetError(`Missing config.json at ${target.storePath}`, {
        configPath,
      });
    }

    const targetId = config.targetId ?? config.defaultTargetId ?? null;
    if (!targetId) {
      throw new TargetError("Missing targetId in config.", { configPath });
    }

    let seed = config.fingerprintSeed;
    let generated = false;
    if (!seed) {
      seed = crypto.randomBytes(16).toString("hex");
      generated = true;
    }

    const storeDir = config.storeDir ?? ".ato";
    const fingerprint = computeFingerprint({ targetId, storeDir, seed });
    const nextConfig = {
      ...config,
      fingerprintSeed: seed,
      fingerprint,
    };
    await writeJsonFile(configPath, nextConfig);

    const registryPath = path.join(target.storePath, "targets.json");
    const registry = await readJson<TargetRegistry>(registryPath, null);
    let registryUpdated = false;
    if (registry?.targets?.length) {
      const entry = registry.targets.find((target) => target.id === targetId);
      if (entry) {
        entry.fingerprint = fingerprint;
        await writeJsonFile(registryPath, registry);
        registryUpdated = true;
      }
    }

    const configRel = toRelativePath(root, configPath);
    const registryRel = registryUpdated ? toRelativePath(root, registryPath) : null;
    const payload = {
      ok: true,
      targetId,
      seed,
      fingerprint,
      configPath: configRel,
      registryPath: registryRel,
      generated,
    };

    if (json) {
      writeJson(payload);
    } else {
      writeLines([
        `repo: ${targetId}`,
        `seed: ${generated ? "generated" : "existing"}`,
        `fingerprint: ${fingerprint}`,
        `config: ${configRel}`,
        registryUpdated ? `registry: ${registryRel}` : "registry: unchanged",
      ]);
    }
    return;
  }

  const helpLines = [
    "Usage:",
    "  ato --repo <id|path> repo resolve",
    "  ato repo list",
    "  ato repo init-seed",
  ];

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown repo subcommand." },
    });
  } else {
    writeLines(["Unknown repo subcommand.", ...helpLines]);
  }
  process.exitCode = 1;
};
