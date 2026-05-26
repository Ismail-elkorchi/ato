import { nodeAdapter } from "./node.js";
import { phpAdapter } from "./php.js";
import { pythonAdapter } from "./python.js";
import { researchAdapter } from "./research.js";
import type { AdapterId, CoreAdapter } from "./types.js";

export const DEFAULT_ADAPTER_ID: AdapterId = "node";

const ADAPTERS: CoreAdapter[] = [
  nodeAdapter,
  pythonAdapter,
  phpAdapter,
  researchAdapter,
];

const ADAPTER_MAP = new Map<AdapterId, CoreAdapter>(
  ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

const normalizeAdapterId = (id?: string | null): AdapterId => {
  const normalized = typeof id === "string" ? id.trim() : "";
  return (normalized || DEFAULT_ADAPTER_ID) as AdapterId;
};

export const listAdapters = (): CoreAdapter[] => [...ADAPTERS];

export const resolveAdapter = (id?: string | null): CoreAdapter => {
  const normalized = normalizeAdapterId(id);
  const adapter = ADAPTER_MAP.get(normalized);
  if (!adapter) {
    throw new Error(`Unknown adapter id '${normalized}'.`);
  }
  if (adapter.status !== "enabled") {
    throw new Error(`Adapter '${normalized}' is present but disabled.`);
  }
  return adapter;
};
