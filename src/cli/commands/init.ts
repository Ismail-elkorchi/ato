import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  ensureDir,
  fileExists,
  readJson,
  writeJson as writeJsonFile,
  writeJsonl,
} from "../../core/fs.js";
import { computeFingerprint } from "../../core/targets/fingerprint.js";
import type { CommandContext } from "../types.js";
import type { AtoConfig, JsonValue, QueueItem } from "../../core/types.js";

const TEMPLATE_DIR = fileURLToPath(
  new URL("../../../templates/repo/.ato", import.meta.url),
);
const ROOT_TEMPLATE_DIR = fileURLToPath(
  new URL("../../../templates/repo", import.meta.url),
);

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const toRelativePath = (root: string, filePath: string): string =>
  toPosixPath(path.relative(root, filePath) || ".");

const toRelativeFromCwd = (filePath: string): string =>
  toPosixPath(path.relative(process.cwd(), filePath) || ".");

const resolveStoreInitPath = async (
  selection: string | null,
  root: string,
): Promise<string> => {
  if (!selection) return path.join(root, ".ato");
  const resolved = path.resolve(process.cwd(), selection);
  if (
    path.basename(resolved) === "config.json" ||
    path.basename(resolved) === "targets.json"
  ) {
    return path.dirname(resolved);
  }
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) return resolved;
    if (stat.isFile()) return path.dirname(resolved);
  } catch {
    return resolved;
  }
  return resolved;
};

const resolveInitRoot = async (selection: string | null): Promise<string> => {
  const base = selection ? path.resolve(process.cwd(), selection) : process.cwd();
  try {
    const stat = await fs.stat(base);
    if (stat.isDirectory()) return base;
    if (stat.isFile()) return path.dirname(base);
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    throw new Error(
      `Unable to resolve init root at ${selection ?? base}: ${message}`,
    );
  }
  throw new Error(`Init root is not a file or directory: ${base}`);
};

const loadTemplateJson = async (
  name: string,
): Promise<Record<string, JsonValue>> => {
  const templatePath = path.join(TEMPLATE_DIR, name);
  const payload = await readJson<Record<string, JsonValue>>(templatePath, null);
  if (!payload) {
    throw new Error(`Missing template at ${templatePath}`);
  }
  return payload;
};

const loadTemplateText = async (
  baseDir: string,
  name: string,
): Promise<string> => {
  const templatePath = path.join(baseDir, name);
  return fs.readFile(templatePath, "utf8");
};

const resolvePlatformContractPath = (config: AtoConfig): string | null => {
  const contracts = config.contracts;
  if (!contracts) return null;
  if (typeof contracts === "string") return contracts;
  if (Array.isArray(contracts)) return contracts[0] ?? null;
  if (typeof contracts === "object") return contracts.platform ?? null;
  return null;
};

export const runInitCommand = async ({
  args,
  context,
}: {
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  const selection = context.repo ?? process.env["ATO_REPO"] ?? null;
  const root = await resolveInitRoot(selection);
  const storeSelection = context.store ?? process.env["ATO_STORE"] ?? null;
  const storePath = await resolveStoreInitPath(storeSelection, root);
  const storeDir = toRelativePath(root, storePath);
  const agentsPath = path.join(root, "AGENTS.md");

  let createdAgents = false;
  if (!(await fileExists(agentsPath))) {
    const agentsTemplate = await loadTemplateText(ROOT_TEMPLATE_DIR, "AGENTS.md");
    await fs.writeFile(agentsPath, agentsTemplate, "utf8");
    createdAgents = true;
  }

  if (await fileExists(storePath)) {
    const existingConfig = await readJson<Record<string, JsonValue>>(
      path.join(storePath, "config.json"),
      null,
    );
    if (!existingConfig) {
      const message = `Store exists but config is missing at ${storePath}`;
      if (json) {
        writeJson({ ok: false, code: 1, error: { message } });
      } else {
        writeLines([`error: ${message}`]);
      }
      process.exitCode = 1;
      return;
    }

    const parsedConfig = existingConfig as unknown as AtoConfig;
    const resolvedTargetId =
      typeof parsedConfig.targetId === "string"
        ? String(parsedConfig.targetId)
        : typeof parsedConfig.defaultTargetId === "string"
          ? String(parsedConfig.defaultTargetId)
          : undefined;
    const created = [...(createdAgents ? [agentsPath] : [])];
    const outputTargetId = resolvedTargetId ?? null;

    const platformContract = resolvePlatformContractPath(parsedConfig);
    const canonicalPlatformContract = toRelativePath(
      root,
      path.join(storePath, "contracts", "PLATFORM_CONTRACT.md"),
    );
    if (platformContract === canonicalPlatformContract) {
      const contractDocPath = path.join(storePath, "contracts", "PLATFORM_CONTRACT.md");
      if (!(await fileExists(contractDocPath))) {
        const contractDoc = await loadTemplateText(
          TEMPLATE_DIR,
          path.join("contracts", "PLATFORM_CONTRACT.md"),
        );
        await ensureDir(path.dirname(contractDocPath));
        await fs.writeFile(contractDocPath, contractDoc, "utf8");
        created.push(contractDocPath);
      }
    }

    if (json) {
      writeJson({
        ok: true,
        root: toRelativeFromCwd(root),
        store: toRelativePath(root, storePath),
        storeDir,
        targetId: outputTargetId,
        already_initialized: true,
        created: created.map((entry) => toRelativePath(root, entry)),
      });
    } else {
      writeLines([
        `root: ${root}`,
        `store: ${storePath}`,
        outputTargetId ? `target: ${outputTargetId}` : null,
      ]);
    }
    return;
  }

  const rawId = flags["id"] ?? flags["target-id"] ?? null;
  if (rawId === true) {
    throw new Error("--id requires a value.");
  }
  const targetId = String(rawId ?? path.basename(root)).trim();
  if (!targetId) {
    throw new Error("Missing target id. Provide --id <targetId>.");
  }

  const rawSeed = flags["seed"] ?? null;
  if (rawSeed === true) {
    throw new Error("--seed requires a value.");
  }
  const seed = String(rawSeed ?? crypto.randomBytes(16).toString("hex"));
  if (!seed) {
    throw new Error("Missing fingerprint seed. Provide --seed <hex>.");
  }

  const fingerprint = computeFingerprint({ targetId, storeDir, seed });

  const templateConfig = await loadTemplateJson("config.json");
  const templateRegistry = await loadTemplateJson("targets.json");
  const config: AtoConfig = {
    ...templateConfig,
    targetId,
    defaultTargetId: targetId,
    storeDir,
    fingerprintSeed: seed,
    fingerprint,
  };
  if (config.contracts && typeof config.contracts === "object" && !Array.isArray(config.contracts)) {
    config.contracts = {
      ...config.contracts,
      platform: toRelativePath(
        root,
        path.join(storePath, "contracts", "PLATFORM_CONTRACT.md"),
      ),
    };
  }
  const platformContract = resolvePlatformContractPath(config);

  const targetTemplate =
    Array.isArray(templateRegistry["targets"]) &&
    templateRegistry["targets"].length
      ? (templateRegistry["targets"][0] as Record<string, JsonValue>)
      : {};

  const registry = {
    ...templateRegistry,
    targets: [
      {
        ...targetTemplate,
        id: targetId,
        root: toRelativePath(storePath, root),
        storeDir,
        fingerprint,
      },
    ],
  };

  await ensureDir(storePath);
  await ensureDir(path.join(storePath, "queue"));
  await ensureDir(path.join(storePath, "lessons"));
  await ensureDir(path.join(storePath, "patterns"));
  await ensureDir(path.join(storePath, "blackboard", "inbox"));
  await ensureDir(path.join(storePath, "cache"));
  await ensureDir(path.join(storePath, "contracts"));

  await writeJsonFile(path.join(storePath, "config.json"), config);
  await writeJsonFile(path.join(storePath, "targets.json"), registry);
  let contractDocPath: string | null = null;
  if (
    platformContract ===
    toRelativePath(root, path.join(storePath, "contracts", "PLATFORM_CONTRACT.md"))
  ) {
    const contractDoc = await loadTemplateText(
      TEMPLATE_DIR,
      path.join("contracts", "PLATFORM_CONTRACT.md"),
    );
    contractDocPath = path.join(storePath, "contracts", "PLATFORM_CONTRACT.md");
    await fs.writeFile(contractDocPath, contractDoc, "utf8");
  }

  const now = new Date().toISOString();
  const bootstrapItem: QueueItem = {
    id: "BL-0001",
    title: "Bootstrap queue item",
    type: "tooling",
    status: "queued",
    priority: "P2",
    tags: ["bootstrap"],
    created_at: now,
    updated_at: now,
    target: { selector: "milestone", value: "bootstrap" },
    deps: [],
    evidence: [],
    owner: "agent",
    notes: "Seeded by ato init. Evidence: output:seed",
    spec: {
      problem: "A freshly initialized repo needs a valid queue item to start a cycle.",
      outcome: "Cycle start can select a valid item and produce initial artifacts.",
      plan: {
        steps: ["Start a cycle", "Finish the cycle"],
      },
      acceptance_criteria: [
        "cmd:ato cycle start --json",
        "cmd:ato cycle finish --json",
      ],
      inputs: [
        `file:${toRelativePath(
          root,
          path.join(storePath, "contracts", "PLATFORM_CONTRACT.md"),
        )}`,
      ],
      deliverables: ["bootstrap cycle start"],
      scope: ["bootstrap"],
      risks: ["low"],
      contract_refs: ["1"],
      runbook: [],
    },
  };
  await writeJsonl(path.join(storePath, "queue", "items.jsonl"), [bootstrapItem]);
  await writeJsonl(path.join(storePath, "lessons", "items.jsonl"), []);
  await writeJsonl(path.join(storePath, "patterns", "items.jsonl"), []);

  const created = [
    ...(createdAgents ? [agentsPath] : []),
    path.join(storePath, "config.json"),
    path.join(storePath, "targets.json"),
    path.join(storePath, "queue", "items.jsonl"),
    ...(contractDocPath ? [contractDocPath] : []),
    path.join(storePath, "blackboard", "inbox"),
    path.join(storePath, "lessons", "items.jsonl"),
    path.join(storePath, "patterns", "items.jsonl"),
  ];

  if (json) {
    writeJson({
      ok: true,
      root: toRelativeFromCwd(root),
      store: toRelativePath(root, storePath),
      storeDir,
      targetId,
      seed,
      fingerprint,
      created: created.map((entry) => toRelativePath(root, entry)),
    });
  } else {
    writeLines([
      `root: ${root}`,
      `store: ${storePath}`,
      `target: ${targetId}`,
      `seed: ${seed}`,
      `fingerprint: ${fingerprint}`,
      "created:",
      ...created.map((entry) => `- ${entry}`),
    ]);
  }
};
