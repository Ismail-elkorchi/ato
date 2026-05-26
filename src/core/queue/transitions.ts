import crypto from "node:crypto";
import { stableStringify } from "../fs.js";
import type {
  QueueItem,
  QueueStatus,
  QueueTarget,
  TargetSelector,
} from "../types.js";

export const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "bug",
  "debt",
  "waiver",
  "quality-debt",
  "feature",
  "doc",
  "contract",
  "tooling",
  "investigation",
]);

export const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "active",
  "blocked",
  "done",
  "dropped",
]);

export const ALLOWED_PRIORITIES: ReadonlySet<string> = new Set([
  "P0",
  "P1",
  "P2",
  "P3",
  "P4",
]);

export const TARGET_SELECTORS: ReadonlySet<TargetSelector> = new Set([
  "exact",
  "range",
  "milestone",
  "unbounded",
]);

export const STATUS_TRANSITIONS: ReadonlyMap<
  QueueStatus,
  ReadonlySet<QueueStatus>
> = new Map([
  ["queued", new Set(["active", "blocked", "dropped"])],
  ["active", new Set(["blocked", "done", "dropped"])],
  ["blocked", new Set(["queued", "active", "dropped"])],
  ["done", new Set()],
  ["dropped", new Set()],
]);

export const normalizeTags = (tags: Array<unknown>): string[] => {
  const normalized = tags
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());
  return [...new Set(normalized)].sort();
};

export const normalizeEvidence = (evidence: Array<unknown>): string[] => {
  const normalized = evidence
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  return [...new Set(normalized)].sort();
};

export const normalizeDeps = (deps: Array<unknown>): string[] => {
  const normalized = deps.map((dep) => String(dep).trim()).filter(Boolean);
  return [...new Set(normalized)].sort();
};

const stripTargetPrefix = (selector: string, value: string): string => {
  const prefix = `${selector}:`;
  let next = value;
  while (next.startsWith(prefix)) {
    next = next.slice(prefix.length);
  }
  return next;
};

const normalizeTargetValue = (
  selector: TargetSelector | string | undefined,
  value: unknown,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return raw;
  if (!selector || selector === "unbounded") return raw;
  return stripTargetPrefix(selector, raw);
};

export const parseTargetInput = (input: unknown): QueueTarget => {
  if (!input) return { selector: "unbounded" };
  const raw = String(input).trim();
  if (!raw || raw === "unbounded") return { selector: "unbounded" };
  if (raw.startsWith("milestone:")) {
    return {
      selector: "milestone",
      value: stripTargetPrefix("milestone", raw),
    };
  }
  if (raw.startsWith("range:")) {
    return { selector: "range", value: stripTargetPrefix("range", raw) };
  }
  if (raw.startsWith("exact:")) {
    return { selector: "exact", value: stripTargetPrefix("exact", raw) };
  }
  if (raw.endsWith(".x") || raw.includes("x")) {
    return { selector: "range", value: stripTargetPrefix("range", raw) };
  }
  return { selector: "exact", value: stripTargetPrefix("exact", raw) };
};

export const normalizeTarget = (target: QueueTarget | null): QueueTarget => {
  if (!target || typeof target !== "object") return { selector: "unbounded" };
  const selector = target.selector ?? target.kind ?? "unbounded";
  const normalized: QueueTarget = { selector };
  if (target.value !== undefined) {
    const normalizedValue = normalizeTargetValue(selector, target.value);
    if (normalizedValue !== undefined) {
      normalized.value = normalizedValue;
    }
  }
  return normalized;
};

export const formatTarget = (target: QueueTarget | null): string => {
  if (!target) return "unbounded";
  const selector = target.selector ?? target.kind ?? "unbounded";
  if (selector === "unbounded") return "unbounded";
  const value = normalizeTargetValue(selector, target.value) ?? "";
  return `${selector}:${value}`;
};

export const ensureTargetValue = (target: QueueTarget | null): boolean => {
  const selector = target?.selector ?? target?.kind;
  if (!selector) return false;
  if (selector === "unbounded") return true;
  return Boolean(target?.value && String(target.value).trim());
};

export const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

export const buildCoreSnapshot = (item: QueueItem) => ({
  id: item.id,
  title: item.title,
  type: item.type,
  status: item.status,
  target: item.target,
  deps: item.deps,
  created_at: item.created_at,
  completed_at: item.completed_at ?? null,
  notes: item.notes,
  spec: item.spec ?? null,
  details: item.details ?? null,
});

export const computeCoreHash = (item: QueueItem): string => {
  const snapshot = buildCoreSnapshot(item);
  const serialized = stableStringify(snapshot);
  return crypto.createHash("sha256").update(serialized).digest("hex");
};
