import path from "node:path";
import { promises as fs } from "node:fs";

import { readJson, fileExists } from "../fs.js";
import { computeFingerprint } from "./fingerprint.js";
import type {
  AtoConfig,
  ResolveTargetResult,
  TargetContext,
  TargetRegistry,
  TargetRegistryEntry,
} from "../types.js";

export class TargetError extends Error {
  code: number | string;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TargetError";
    this.code = 2;
    this.details = details;
  }
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const normalizeRelativePath = (from: string, to: string): string =>
  normalizePath(path.relative(from, to) || ".");

const findNearestStoreBootstrap = async (
  startDir: string,
): Promise<{ rootDir: string | null; storePath: string } | null> => {
  let current = path.resolve(startDir);
  while (true) {
    const directConfig = path.join(current, "config.json");
    const directRegistry = path.join(current, "targets.json");
    if (
      (await fileExists(directConfig)) ||
      (await fileExists(directRegistry))
    ) {
      return {
        rootDir: null,
        storePath: current,
      };
    }

    const repoStore = path.join(current, ".ato");
    if (await fileExists(path.join(repoStore, "config.json"))) {
      return {
        rootDir: current,
        storePath: repoStore,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const loadConfig = async (
  storePath: string,
): Promise<{ configPath: string; config: AtoConfig }> => {
  const configPath = path.join(storePath, "config.json");
  const config = await readJson<AtoConfig>(configPath, null);
  if (!config) {
    throw new TargetError(`Missing config.json at ${storePath}`, {
      configPath,
    });
  }
  return { configPath, config };
};

const loadRegistry = async (
  storePath: string,
): Promise<{ registryPath: string; registry: TargetRegistry } | null> => {
  const registryPath = path.join(storePath, "targets.json");
  const registry = await readJson<TargetRegistry>(registryPath, null);
  if (!registry) return null;
  return { registryPath, registry };
};

const resolvePathInput = async (
  input: string,
  cwd: string,
): Promise<string | null> => {
  const resolved = path.resolve(cwd, input);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) return resolved;
    if (stat.isFile()) return path.dirname(resolved);
  } catch {
    return null;
  }
  return null;
};

const inferRootFromStore = ({
  storePath,
  storeDir,
}: {
  storePath: string;
  storeDir: string;
}): string | null => {
  if (!storeDir || path.isAbsolute(storeDir)) return null;
  return path.resolve(storePath, path.relative(storeDir, "."));
};

const isExplicit = (selection: string | null) =>
  selection !== null && selection !== undefined && selection !== "";

const buildNotInitializedError = (
  selection?: string | null,
  storeSelection?: string | null,
): TargetError => {
  const error = new TargetError("ATO is not initialized for this repo.", {
    selection: selection ?? null,
    storeSelection: storeSelection ?? null,
    code: "ATO_NOT_INITIALIZED",
    suggested_fix: ["ato init --json"],
  });
  error.code = "ATO_NOT_INITIALIZED";
  return error;
};

const pickTargetFromRegistry = ({
  registry,
  registryPath,
  targetId,
}: {
  registry: TargetRegistry;
  registryPath: string;
  targetId: string;
}): { entry: TargetRegistryEntry; registryPath: string } => {
  const entry = registry.targets?.find((target) => target.id === targetId);
  if (!entry) {
    throw new TargetError(`Unknown repo '${targetId}'.`, {
      available: registry.targets?.map((target) => target.id) ?? [],
      registryPath,
    });
  }
  return { entry, registryPath };
};

export const resolveTarget = async ({
  cwd,
  selection,
  storeSelection,
  requireWrite,
  allowMissingSeed = false,
}: {
  cwd: string;
  selection: string | null;
  storeSelection: string | null;
  requireWrite: boolean;
  allowMissingSeed?: boolean;
}): Promise<ResolveTargetResult> => {
  void requireWrite;
  const explicit = isExplicit(selection);
  const explicitStore = isExplicit(storeSelection);
  const discovered = await findNearestStoreBootstrap(cwd);

  let rootDir: string | null = null;
  let targetId: string | null = null;
  let registryInfo: { registryPath: string; registry: TargetRegistry } | null =
    null;
  let storePath: string | null =
    explicitStore ? await resolvePathInput(storeSelection ?? "", cwd) : null;

  if (explicitStore && !storePath) {
    throw new TargetError(`Unable to resolve store path '${storeSelection}'.`, {
      selection: storeSelection,
    });
  }

  if (!storePath) {
    storePath = discovered?.storePath ?? null;
  }

  if (explicit) {
    const resolvedPath = await resolvePathInput(selection ?? "", cwd);
    if (resolvedPath) {
      rootDir = resolvedPath;
    } else {
      if (!storePath) {
        throw buildNotInitializedError(selection, storeSelection);
      }
      registryInfo = await loadRegistry(storePath);
      if (!registryInfo) {
        const { config } = await loadConfig(storePath);
        const configuredId = config.defaultTargetId ?? config.targetId ?? null;
        if (configuredId !== (selection ?? "")) {
          throw new TargetError("Missing targets.json for repo ID resolution.", {
            selection,
            storePath,
          });
        }
        targetId = configuredId;
        rootDir =
          discovered?.rootDir ??
          inferRootFromStore({
            storePath,
            storeDir: config.storeDir ?? ".ato",
          });
      } else {
        const picked = pickTargetFromRegistry({
          registry: registryInfo.registry,
          registryPath: registryInfo.registryPath,
          targetId: selection ?? "",
        });
        targetId = picked.entry.id;
        rootDir = path.resolve(storePath, picked.entry.root);
      }
    }
  } else {
    if (!storePath) {
      throw buildNotInitializedError(selection, storeSelection);
    }
    registryInfo = await loadRegistry(storePath);

    const { config } = await loadConfig(storePath);
    const defaultId = config.defaultTargetId ?? config.targetId ?? null;

    if (registryInfo) {
      const registryTargets = registryInfo.registry.targets ?? [];
      if (registryTargets.length) {
        const targetIds = registryTargets.map((target) => target.id);
        const soleTarget = registryTargets.length === 1 ? registryTargets[0] : null;
        const selectedId =
          defaultId && targetIds.includes(defaultId)
            ? defaultId
            : soleTarget?.id ?? null;
        if (!selectedId) {
          throw new TargetError("Unable to select a repo from registry.", {
            available: targetIds,
          });
        }
        const picked = pickTargetFromRegistry({
          registry: registryInfo.registry,
          registryPath: registryInfo.registryPath,
          targetId: selectedId,
        });
        targetId = picked.entry.id;
        rootDir = path.resolve(storePath, picked.entry.root);
      } else {
        rootDir =
          discovered?.rootDir ??
          inferRootFromStore({
            storePath,
            storeDir: config.storeDir ?? ".ato",
          });
      }
    } else {
      rootDir =
        discovered?.rootDir ??
        inferRootFromStore({
          storePath,
          storeDir: config.storeDir ?? ".ato",
        });
      targetId = defaultId;
    }
  }

  if (!rootDir || !storePath) {
    throw new TargetError("Unable to resolve repo root.", {
      selection,
      storeSelection,
    });
  }

  const { configPath, config } = await loadConfig(storePath);
  const targetRoot = path.resolve(rootDir);
  const storeDir = config.storeDir ?? normalizeRelativePath(targetRoot, storePath);
  const resolvedStorePath = path.resolve(targetRoot, storeDir);
  const targetIdResolved = targetId ?? config.targetId ?? null;

  if (path.resolve(storePath) !== resolvedStorePath) {
    throw new TargetError("Configured storeDir does not match resolved store path.", {
      root: targetRoot,
      storeDir,
      storePath,
      expectedStorePath: resolvedStorePath,
      configPath,
    });
  }

  if (!targetIdResolved) {
    throw new TargetError("Missing repo id in config and selection.", {
      configPath,
    });
  }

  const seed = config.fingerprintSeed;
  if (!seed && !allowMissingSeed) {
    throw new TargetError(
      "Missing fingerprintSeed in config.json. Run `ato repo init-seed`.",
      { configPath },
    );
  }

  const computedFingerprint = seed
    ? computeFingerprint({
        targetId: targetIdResolved,
        storeDir,
        seed,
      })
    : config.fingerprint ?? "";

  if (seed && config.fingerprint && config.fingerprint !== computedFingerprint) {
    throw new TargetError("Repo fingerprint mismatch with config.", {
      expected: config.fingerprint,
      actual: computedFingerprint,
    });
  }

  if (seed && registryInfo?.registry?.targets?.length) {
    const entry = registryInfo.registry.targets.find(
      (target) => target.id === targetIdResolved,
    );
    if (entry?.fingerprint && entry.fingerprint !== computedFingerprint) {
      throw new TargetError("Repo fingerprint mismatch with registry.", {
        expected: entry.fingerprint,
        actual: computedFingerprint,
      });
    }
  }

  return {
    target: {
      id: targetIdResolved,
      root: targetRoot,
      storeDir,
      storePath: resolvedStorePath,
      configPath,
      fingerprint: computedFingerprint,
      config,
      registry: registryInfo?.registry ?? null,
    } satisfies TargetContext,
    explicit,
  };
};
