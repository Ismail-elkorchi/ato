import { loadBlockConfig, resolveBlockState } from "./config.js";

export type HoldoutTask = {
  id: string;
  cmd: string[];
};

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

export const normalizeHoldoutGateId = (value: string): string => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("holdout-") ? trimmed : `holdout-${trimmed}`;
};

export const resolveHoldoutTasks = async ({
  store,
  blockId,
}: {
  store: string;
  blockId?: string | null;
}): Promise<HoldoutTask[]> => {
  const resolvedBlockId =
    blockId === undefined ? (await resolveBlockState(store)).active_block_id : blockId;
  const block = resolvedBlockId
    ? await loadBlockConfig(store, resolvedBlockId)
    : null;
  const blockObj = asObject(block);
  const holdout = asObject(blockObj?.["holdout"]);
  const tasksRaw = holdout && Array.isArray(holdout["tasks"])
    ? (holdout["tasks"] as unknown[])
    : [];
  const tasks: HoldoutTask[] = [];
  for (const entry of tasksRaw) {
    const taskObj = asObject(entry);
    if (!taskObj) continue;
    const idRaw = typeof taskObj["id"] === "string" ? taskObj["id"] : "";
    const cmdRaw = Array.isArray(taskObj["cmd"])
      ? taskObj["cmd"]
      : Array.isArray(taskObj["command"])
        ? taskObj["command"]
        : [];
    const cmd = cmdRaw.map((item) => String(item)).filter(Boolean);
    const id = String(idRaw).trim();
    if (!id || !cmd.length) continue;
    tasks.push({ id, cmd });
  }
  return tasks;
};
