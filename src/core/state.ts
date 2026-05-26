import path from "node:path";

import { readJson, writeJson } from "./fs.js";

type State = {
  version: number;
  targetId?: string;
  activeQueueId?: string;
  activeCycleId?: string;
  activeCycleQueueId?: string;
  activeCycleStartedAt?: string;
  mode?: "fast" | "standard" | "deep";
  lastPack?: { bytes: number; budget: number; ts: string; tokens?: number | null };
  lastGate?: { mode: "fast" | "full"; ok: boolean; ts: string };
  lastReflect?: { queueId: string; ts: string };
};

export const getStatePath = (store: string): string =>
  path.join(store, "state.json");

export const readState = async (store: string): Promise<State> => {
  return (
    (await readJson<State>(getStatePath(store), { version: 1 })) ?? {
      version: 1,
    }
  );
};

export const writeState = async (store: string, state: State): Promise<void> => {
  await writeJson(getStatePath(store), state);
};
