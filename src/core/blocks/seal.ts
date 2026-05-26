import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createAjv } from "../schemas/ajv.js";

import { stableStringify, readJson } from "../fs.js";
import type { AtoConfig, JsonValue } from "../types.js";
import { resolveAdapter } from "../adapters/registry.js";
import { resolveGateConfig } from "../gates/overrides.js";
import { listGateCommands, type GateCommand } from "../gates/runner.js";
import { resolveHoldoutTasks } from "./holdout.js";

const SCHEMA_URL = new URL("../schemas/block-seal.v1.json", import.meta.url);

export type GateObligations = {
  obligations_hash: string;
  inputs: {
    adapter_id: string;
    gate_plan: Array<{ id: string; cmd: string[]; cwd?: string; kind?: string }>;
    gate_config: JsonValue;
    holdout_tasks: Array<{ id: string; cmd: string[] }>;
    overrides: JsonValue;
  };
};

export type BlockSealVerifyResult = {
  ok: boolean;
  block_id: string;
  seal_path: string;
  obligations_hash: string;
  errors: Array<{ kind: string; message: string }>;
  guidance: string[];
  computed?: GateObligations;
};

const loadSealSchema = async (): Promise<unknown> => {
  const raw = await fs.readFile(SCHEMA_URL, "utf8");
  return JSON.parse(raw);
};

const normalizeObligationCmd = (cmd: string[]): string[] =>
  cmd.map((part) => String(part).trim()).filter(Boolean);

const normalizeCmd = (gate: GateCommand): string[] => {
  const cmd = Array.isArray(gate.cmd)
    ? gate.cmd
    : Array.isArray(gate.command)
      ? gate.command
      : [];
  return normalizeObligationCmd(cmd);
};

const normalizeGatePlan = (gates: GateCommand[]) =>
  gates.map((gate) => {
    const entry: { id: string; cmd: string[]; cwd?: string; kind?: string } = {
      id: String(gate.id),
      cmd: normalizeCmd(gate),
    };
    if (gate.cwd) entry.cwd = String(gate.cwd);
    if (gate.kind) entry.kind = String(gate.kind);
    return entry;
  });

const hashObligations = (payload: GateObligations["inputs"]): string =>
  crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");

const toJsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

export const blockSealPath = (store: string, blockId: string): string =>
  path.join(store, "meta", "blocks", `${blockId}.seal.json`);

export const computeGateObligations = async ({
  root,
  targetId,
  config,
  blockId,
}: {
  root: string;
  targetId: string;
  config: AtoConfig;
  blockId?: string | null;
}): Promise<GateObligations> => {
  const adapter = resolveAdapter();
  const resolved = resolveGateConfig({
    config,
    targetId,
  });
  const gateConfig = {
    gates: resolved.effective,
    ...(typeof config.storeDir === "string" ? { storeDir: config.storeDir } : {}),
  };
  const { plan } = await listGateCommands({
    config: gateConfig,
    mode: "full",
    root,
    ...(blockId ? { blockId } : {}),
  });

  const store = path.resolve(root, config.storeDir ?? ".ato");
  const holdoutTasks = await resolveHoldoutTasks(
    blockId ? { store, blockId } : { store },
  );

  const inputs = {
    adapter_id: adapter.id,
    gate_plan: normalizeGatePlan(plan.gates ?? []),
    gate_config: toJsonValue(resolved.effective),
    holdout_tasks: holdoutTasks.map((task) => ({
      id: task.id,
      cmd: normalizeObligationCmd(task.cmd),
    })),
    overrides: toJsonValue({
      applied: resolved.overrides.applied,
      targetId: resolved.overrides.targetId,
      source: resolved.overrides.source,
      config: resolved.overrides.config ?? null,
    }),
  };

  return {
    obligations_hash: hashObligations(inputs),
    inputs,
  };
};

export const verifyBlockSeal = async ({
  root,
  store,
  targetId,
  config,
  blockId,
  computed,
}: {
  root: string;
  store: string;
  targetId: string;
  config: AtoConfig;
  blockId: string;
  computed?: GateObligations;
}): Promise<BlockSealVerifyResult> => {
  const sealPath = blockSealPath(store, blockId);
  const seal = await readJson<Record<string, unknown> | null>(sealPath, null);
  const errors: Array<{ kind: string; message: string }> = [];
  const guidance = new Set<string>();

  if (!seal) {
    errors.push({
      kind: "seal_missing",
      message: `Block seal missing at ${sealPath}.`,
    });
    guidance.add("Create the block seal file before completing the cycle.");
  }

  const computedObligations =
    computed ??
    (await computeGateObligations({
      root,
      targetId,
      config,
      blockId,
    }));

  if (seal) {
    const schema = await loadSealSchema();
    const ajv = createAjv();
    const validate = ajv.compile(schema);
    const ok = validate(seal);
    if (!ok) {
      for (const error of validate.errors ?? []) {
        errors.push({
          kind: "schema",
          message: `${error.instancePath} ${error.message}`,
        });
      }
      guidance.add("Update the block seal to match block-seal.v1.");
    }

    const sealedHash =
      typeof seal["obligations_hash"] === "string"
        ? seal["obligations_hash"].trim()
        : "";
    const sealInputs =
      seal && typeof seal["inputs"] === "object" && !Array.isArray(seal["inputs"])
        ? (seal["inputs"] as GateObligations["inputs"])
        : null;
    if (sealedHash && sealInputs) {
      const computedSealHash = hashObligations(sealInputs);
      if (computedSealHash !== sealedHash) {
        errors.push({
          kind: "seal_hash_invalid",
          message: "Block seal inputs do not match obligations_hash.",
        });
        guidance.add("Recreate the block seal from current obligations.");
      }
    }
    if (sealedHash && sealedHash !== computedObligations.obligations_hash) {
      errors.push({
        kind: "hash_mismatch",
        message: "Gate obligations hash does not match block seal.",
      });
      guidance.add("Create a new block_id with a new baseline if obligations changed.");
    }
  }

  return {
    ok: errors.length === 0,
    block_id: blockId,
    seal_path: path.relative(root, sealPath).replace(/\\/g, "/"),
    obligations_hash: computedObligations.obligations_hash,
    errors,
    guidance: [...guidance],
    ...(errors.length ? { computed: computedObligations } : {}),
  };
};
