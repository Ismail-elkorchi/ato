import path from "node:path";
import { promises as fs } from "node:fs";
import { validateQueueItems } from "../core/queue/validate.js";
import { getQueuePaths } from "../core/queue/store.js";
import {
  selectNextItems,
  priorityRank,
  statusRank,
  targetSpecificity,
} from "../core/queue/ordering.js";
import { formatTarget } from "../core/queue/transitions.js";
import type { QueueItem, QueueNeed, QueueTarget } from "../core/types.js";

const HEADER = (note: string): string =>
  [
    "<!-- GENERATED FILE: do not edit by hand. -->",
    `<!-- ${note} -->`,
    "",
  ].join("\n");

const renderItemLine = (item: QueueItem): string => {
  const target = formatTarget(item.target);
  const tags = (item.tags ?? []).join(", ") || "none";
  const deps = (item.deps ?? []).join(", ") || "none";
  return `- ${item.id} [${item.priority}] ${item.status} — ${item.title} | target: ${target} | tags: ${tags} | deps: ${deps}`;
};

const renderQueueIdList = (ids: string[]): string => {
  if (!ids.length) return "- None.";
  return ids.map((id) => `- ${id}`).join("\n");
};

const sortItems = (items: QueueItem[]): QueueItem[] =>
  [...items].sort((a, b) => {
    const targetDiff =
      targetSpecificity(a.target) - targetSpecificity(b.target);
    if (targetDiff !== 0) return targetDiff;
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const createdDiff = String(a.created_at).localeCompare(
      String(b.created_at),
    );
    if (createdDiff !== 0) return createdDiff;
    return String(a.id).localeCompare(String(b.id));
  });

const buildBacklogView = (items: QueueItem[]): string => {
  const openItems = items.filter(
    (item) => !["done", "dropped"].includes(item.status),
  );
  const grouped = {
    active: openItems.filter((item) => item.status === "active"),
    queued: openItems.filter((item) => item.status === "queued"),
    blocked: openItems.filter((item) => item.status === "blocked"),
  };

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# BACKLOG (Generated View)",
    "",
    "Purpose: Human-readable backlog view sourced from the queue store.",
    "",
    "## Active",
    grouped.active.length
      ? sortItems(grouped.active).map(renderItemLine).join("\n")
      : "- None.",
    "",
    "## Queued",
    grouped.queued.length
      ? sortItems(grouped.queued).map(renderItemLine).join("\n")
      : "- None.",
    "",
    "## Blocked",
    grouped.blocked.length
      ? sortItems(grouped.blocked).map(renderItemLine).join("\n")
      : "- None.",
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const buildStateView = async (items: QueueItem[]): Promise<string> => {
  const activeIds = items
    .filter((item) => item.status === "active")
    .map((item) => item.id)
    .sort();
  const blockedIds = items
    .filter((item) => item.status === "blocked")
    .map((item) => item.id)
    .sort();

  const queuedRecords = items
    .filter((item) => item.status !== "active")
    .map((item) => ({ item }));
  const { selected } = selectNextItems({
    items: queuedRecords,
    target: null,
    focus: null,
    limit: 5,
  });
  const nextSafeIds = selected.map((entry) => entry.item.id);

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# STATE_PRESENT (Generated View)",
    "",
    "Purpose: Present-tense pointers for phase, in-progress IDs, next-safe IDs, and blockers.",
    "",
    "## In Progress (Queue IDs)",
    renderQueueIdList(activeIds),
    "",
    "## Next Safe Work (Queue IDs, dependency-respecting)",
    renderQueueIdList(nextSafeIds),
    "",
    "## Known Blockers (Queue IDs)",
    renderQueueIdList(blockedIds),
    "",
  ];

  return `${lines.join("\n")}\n`;
};

const buildReleasesView = async (items: QueueItem[]): Promise<string> => {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = formatTarget(item.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(item);
  }

  const sortedKeys = [...groups.keys()].sort();
  const threshold = "P2";
  const thresholdRank = priorityRank(threshold);

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl"),
    "# RELEASES (Generated View)",
    "",
    "Purpose: Per-target summaries with deterministic readiness checks.",
    "",
    `Readiness threshold: ${threshold} (open items at or above this priority block readiness).`,
    "",
  ];

  for (const key of sortedKeys) {
    const groupItems = groups.get(key) ?? [];
    const openItems = groupItems.filter(
      (item) => !["done", "dropped"].includes(item.status),
    );
    const doneItems = groupItems.filter((item) => item.status === "done");
    const blocking = openItems.filter(
      (item) => priorityRank(item.priority) <= thresholdRank,
    );
    const readiness = blocking.length ? "blocked" : "ready";

    lines.push(`## ${key}`);
    lines.push(`- Readiness: ${readiness}`);
    lines.push(`- Open items: ${openItems.length}`);
    lines.push(`- Done items: ${doneItems.length}`);

    if (openItems.length) {
      lines.push("");
      lines.push("### Open");
      lines.push(sortItems(openItems).map(renderItemLine).join("\n"));
    }

    if (doneItems.length) {
      lines.push("");
      lines.push("### Done");
      lines.push(sortItems(doneItems).map(renderItemLine).join("\n"));
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

const buildNeedsView = (items: QueueItem[]): string => {
  const allNeeds: Array<
    QueueNeed & { queue_id: string; queue_title: string; target: QueueTarget }
  > = [];

  for (const item of items) {
    const needs = item.details?.needs ?? [];
    for (const need of needs) {
      if (need.status === "open") {
        allNeeds.push({
          queue_id: item.id,
          queue_title: item.title,
          target: item.target,
          ...need,
        });
      }
    }
  }

  const grouped = new Map<
    string,
    Array<QueueNeed & { queue_id: string; queue_title: string; target: QueueTarget }>
  >();
  for (const need of allNeeds) {
    const targetKey = formatTarget(need.target);
    if (!grouped.has(targetKey)) grouped.set(targetKey, []);
    grouped.get(targetKey)?.push(need);
  }

  const lines = [
    HEADER("Source: .ato/queue/items.jsonl (details.needs)"),
    "# NEEDS (Generated View)",
    "",
    "Purpose: Open needs grouped by target.",
    "",
    `Total open needs: ${allNeeds.length}`,
    "",
  ];

  const sortedKeys = [...grouped.keys()].sort();
  for (const key of sortedKeys) {
    const needs = grouped.get(key) ?? [];
    lines.push(`## ${key}`);
    lines.push("");
    for (const need of needs) {
      lines.push(`- **${need.kind}** (${need.queue_id}): ${need.ask}`);
      if (need.evidence) lines.push(`  - Evidence: ${need.evidence}`);
    }
    lines.push("");
  }

  if (allNeeds.length === 0) {
    lines.push("No open needs.");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

export const writeQueueViews = async (
  store: string,
  items: QueueItem[],
): Promise<void> => {
  const { viewsDir } = getQueuePaths(store);
  await fs.mkdir(viewsDir, { recursive: true });
  await fs.writeFile(
    path.join(viewsDir, "BACKLOG.md"),
    buildBacklogView(items),
  );
  await fs.writeFile(
    path.join(viewsDir, "STATE_PRESENT.md"),
    await buildStateView(items),
  );
  await fs.writeFile(
    path.join(viewsDir, "RELEASES.md"),
    await buildReleasesView(items),
  );
  await fs.writeFile(path.join(viewsDir, "NEEDS.md"), buildNeedsView(items));
};

export { validateQueueItems };
