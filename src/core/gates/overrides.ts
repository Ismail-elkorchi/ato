import type {
  AtoConfig,
  GateCommandConfig,
  GateOverridesConfig,
  GateTestsConfig,
  GatesConfig,
} from "../types.js";

export type GateOverrideState = {
  applied: boolean;
  targetId: string;
  source: string | null;
  config: GateOverridesConfig | null;
};

export type ResolvedGateConfig = {
  base: GatesConfig;
  effective: GatesConfig;
  overrides: GateOverrideState;
};

type NormalizedGatesConfig = {
  scopeMap: Array<{ prefix: string; scope: string }>;
  fast: GateCommandConfig[];
  full: { tests: GateTestsConfig };
  overrides?: { targets?: Record<string, GateOverridesConfig> };
};

const cloneCommandList = (list: GateCommandConfig[] = []): GateCommandConfig[] =>
  list.map((entry) => ({
    ...entry,
    ...(entry.cmd ? { cmd: [...entry.cmd] } : {}),
    ...(entry.command ? { command: [...entry.command] } : {}),
  }));

const normalizeTests = (tests?: GatesConfig["full"]): GateTestsConfig => {
  const normalizedTests = tests?.tests ?? {};
  return {
    order: normalizedTests.order ? [...normalizedTests.order] : [],
    root: normalizedTests.root ? cloneCommandList(normalizedTests.root) : [],
    scopes: normalizedTests.scopes
      ? Object.fromEntries(
          Object.entries(normalizedTests.scopes).map(([key, list]) => [
            key,
            cloneCommandList(list ?? []),
          ]),
        )
      : {},
  };
};

const normalizeGateConfig = (gates?: GatesConfig): NormalizedGatesConfig => ({
  scopeMap: gates?.scopeMap ? gates.scopeMap.map((entry) => ({ ...entry })) : [],
  fast: gates?.fast ? cloneCommandList(gates.fast) : [],
  full: { tests: normalizeTests(gates?.full) },
  ...(gates?.overrides ? { overrides: gates.overrides } : {}),
});

const assertPlainObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
};

const assertCommandList = (value: unknown, label: string): GateCommandConfig[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected array of gate commands.`);
  }
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid ${label}[${index}]: expected object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate["id"];
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Invalid ${label}[${index}].id: expected non-empty string.`);
    }
    const cmd = candidate["cmd"] ?? candidate["command"];
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((part) => typeof part === "string")) {
      throw new Error(`Invalid ${label}[${index}]: cmd must be a non-empty string array.`);
    }
  });
  return value as GateCommandConfig[];
};

const assertScopeMap = (value: unknown, label: string): GatesConfig["scopeMap"] => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected array.`);
  }
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid ${label}[${index}]: expected object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const prefix = candidate["prefix"];
    const scope = candidate["scope"];
    if (typeof prefix !== "string" || typeof scope !== "string") {
      throw new Error(`Invalid ${label}[${index}]: prefix and scope must be strings.`);
    }
  });
  return value as GatesConfig["scopeMap"];
};

const assertTestsConfig = (value: unknown, label: string): GatesConfig["full"] => {
  const tests = value === undefined ? {} : assertPlainObject(value, label);
  const allowedKeys = new Set(["order", "root", "scopes"]);
  for (const key of Object.keys(tests)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid ${label}: unknown key '${key}'.`);
    }
  }
  if ("order" in tests) {
    const order = tests["order"];
    if (!Array.isArray(order) || !order.every((entry) => typeof entry === "string")) {
      throw new Error(`Invalid ${label}.order: expected string array.`);
    }
  }
  if ("root" in tests) {
    assertCommandList(tests["root"], `${label}.root`);
  }
  if ("scopes" in tests) {
    const scopes = assertPlainObject(tests["scopes"], `${label}.scopes`);
    for (const [scope, list] of Object.entries(scopes)) {
      assertCommandList(list, `${label}.scopes.${scope}`);
    }
  }
  const output: GateTestsConfig = {};
  if (Array.isArray(tests["order"])) {
    output.order = [...(tests["order"] as string[])];
  }
  if (Array.isArray(tests["root"])) {
    output.root = tests["root"] as GateCommandConfig[];
  }
  if ("scopes" in tests) {
    output.scopes = tests["scopes"] as Record<string, GateCommandConfig[]>;
  }
  return { tests: output };
};

const assertOverrideShape = (value: unknown, label: string): GateOverridesConfig => {
  const override = assertPlainObject(value, label);
  const allowedKeys = new Set(["scopeMap", "fast", "full"]);
  for (const key of Object.keys(override)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid ${label}: unknown key '${key}'.`);
    }
  }

  if ("scopeMap" in override) {
    assertScopeMap(override["scopeMap"], `${label}.scopeMap`);
  }
  if ("fast" in override) {
    assertCommandList(override["fast"], `${label}.fast`);
  }
  if ("full" in override) {
    const full = assertPlainObject(override["full"], `${label}.full`);
    const fullKeys = new Set(["tests"]);
    for (const key of Object.keys(full)) {
      if (!fullKeys.has(key)) {
        throw new Error(`Invalid ${label}.full: unknown key '${key}'.`);
      }
    }
    if ("tests" in full) {
      assertTestsConfig(full["tests"], `${label}.full.tests`);
    }
  }

  return override as GateOverridesConfig;
};

const mergeScopes = (
  base: Record<string, GateCommandConfig[]> = {},
  override?: Record<string, GateCommandConfig[]>,
): Record<string, GateCommandConfig[]> => {
  if (!override) return { ...base };
  return { ...base, ...override };
};

const mergeTests = (
  base?: GateTestsConfig,
  override?: GateTestsConfig,
): GateTestsConfig => {
  const output: GateTestsConfig = {};
  if (override?.order) {
    output.order = [...override.order];
  } else if (base?.order) {
    output.order = [...base.order];
  }
  if (override?.root) {
    output.root = cloneCommandList(override.root);
  } else if (base?.root) {
    output.root = cloneCommandList(base.root);
  }
  const scopes = mergeScopes(base?.scopes, override?.scopes);
  if (Object.keys(scopes).length) {
    output.scopes = scopes;
  }
  return output;
};

const mergeGateConfig = (
  base: NormalizedGatesConfig,
  override: GateOverridesConfig,
): NormalizedGatesConfig => ({
  scopeMap: override.scopeMap ? override.scopeMap.map((entry) => ({ ...entry })) : base.scopeMap,
  fast: override.fast ? cloneCommandList(override.fast) : base.fast,
  full: {
    tests: mergeTests(base.full?.tests, override.full?.tests),
  },
  ...(base.overrides ? { overrides: base.overrides } : {}),
});

export const resolveGateConfig = ({
  config,
  targetId,
}: {
  config: AtoConfig;
  targetId: string;
}): ResolvedGateConfig => {
  const base = normalizeGateConfig(config.gates);
  const overrides = config.gates?.overrides;
  if (overrides !== undefined && overrides !== null) {
    const overridesObject = assertPlainObject(overrides, "gates.overrides");
    const overrideKeys = new Set(["targets"]);
    for (const key of Object.keys(overridesObject)) {
      if (!overrideKeys.has(key)) {
        throw new Error(`Invalid gates.overrides: unknown key '${key}'.`);
      }
    }
    if (overrides.targets !== undefined) {
      assertPlainObject(overrides.targets, "gates.overrides.targets");
    }
  }

  const hasOverride =
    overrides?.targets &&
    Object.prototype.hasOwnProperty.call(overrides.targets, targetId);

  if (!hasOverride) {
    return {
      base,
      effective: base,
      overrides: {
        applied: false,
        targetId,
        source: null,
        config: null,
      },
    };
  }

  const source = `gates.overrides.targets.${targetId}`;
  const validated = assertOverrideShape(overrides?.targets?.[targetId], source);
  return {
    base,
    effective: mergeGateConfig(base, validated),
    overrides: {
      applied: true,
      targetId,
      source,
      config: validated,
    },
  };
};
