import type { QueueItem, QueuePriority, QueueStatus, QueueTarget } from "../types.js";

const STATUS_ORDER: ReadonlyMap<QueueStatus, number> = new Map([
  ["active", 0],
  ["queued", 1],
  ["blocked", 2],
  ["dropped", 3],
  ["done", 4],
]);

const TARGET_ORDER: ReadonlyMap<string, number> = new Map([
  ["exact", 0],
  ["range", 1],
  ["milestone", 2],
  ["unbounded", 3],
]);

const PRIORITY_ORDER: ReadonlyMap<Exclude<QueuePriority, number>, number> =
  new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3],
  ["P4", 4],
]);

const toArray = (value: unknown): string[] => {
  if (!value) return [];
  const array = Array.isArray(value) ? value : [value];
  return array.map((entry) => String(entry));
};

export const targetSpecificity = (target: QueueTarget | null): number => {
  const selector = target?.selector ?? target?.kind ?? "unbounded";
  return TARGET_ORDER.get(selector) ?? TARGET_ORDER.get("unbounded") ?? 0;
};

export const priorityRank = (priority: QueuePriority): number => {
  if (typeof priority === "number") return priority;
  return PRIORITY_ORDER.get(priority) ?? PRIORITY_ORDER.get("P4") ?? 0;
};

export const statusRank = (status: QueueStatus): number =>
  STATUS_ORDER.get(status) ?? STATUS_ORDER.get("done") ?? 0;

export const matchesTargetFilter = (
  target: QueueTarget | null,
  filter: QueueTarget | null,
): boolean => {
  if (!filter) return true;
  const selector = target?.selector ?? target?.kind ?? "unbounded";
  if (filter.selector === "unbounded") return selector === "unbounded";
  return selector === filter.selector && target?.value === filter.value;
};

export const matchesFocus = (item: QueueItem, focus: string | null): boolean => {
  if (!focus) return true;
  const focusTag = String(focus).toLowerCase();
  return (item.tags ?? []).some(
    (tag) => String(tag).toLowerCase() === focusTag,
  );
};

export const depsSatisfied = (
  item: QueueItem,
  statusMap: ReadonlyMap<string, QueueStatus>,
): boolean => {
  const deps = toArray(item.deps);
  if (!deps.length) return true;
  return deps.every((dep) => statusMap.get(dep) === "done");
};

export const selectNextItems = ({
  items,
  target,
  focus,
  limit,
}: {
  items: Array<{ item: QueueItem }>;
  target: QueueTarget | null;
  focus: string | null;
  limit: number;
}): {
  selected: Array<{ item: QueueItem; reason: Record<string, unknown> }>;
  statusMap: Map<string, QueueStatus>;
} => {
  const statusMap = new Map(items.map(({ item }) => [item.id, item.status]));
  const candidates = items
    .map(({ item }) => item)
    .filter((item) => ["active", "queued"].includes(item.status))
    .filter((item) => matchesTargetFilter(item.target, target))
    .filter((item) => matchesFocus(item, focus))
    .map((item) => ({
      item,
      deps_ok: depsSatisfied(item, statusMap),
    }))
    .filter((entry) => entry.deps_ok);

  candidates.sort((a, b) => {
    const targetDiff =
      targetSpecificity(a.item.target) - targetSpecificity(b.item.target);
    if (targetDiff !== 0) return targetDiff;
    const statusDiff = statusRank(a.item.status) - statusRank(b.item.status);
    if (statusDiff !== 0) return statusDiff;
    const priorityDiff =
      priorityRank(a.item.priority) - priorityRank(b.item.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const createdDiff = String(a.item.created_at).localeCompare(
      String(b.item.created_at),
    );
    if (createdDiff !== 0) return createdDiff;
    return String(a.item.id).localeCompare(String(b.item.id));
  });

  const selected = candidates.slice(0, limit).map((entry) => {
    const item = entry.item;
    return {
      item,
      reason: {
        target_rank: targetSpecificity(item.target),
        status_rank: statusRank(item.status),
        priority_rank: priorityRank(item.priority),
        deps_satisfied: true,
      },
    };
  });

  return { selected, statusMap };
};
