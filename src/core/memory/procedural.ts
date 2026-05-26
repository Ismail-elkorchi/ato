import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import path from "node:path";

import { readJson, writeJson } from "../fs.js";

export type ProceduralCommand = {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  stdinRequired?: boolean;
};

export type ProceduralEntry = {
  id: string;
  version: number;
  createdAt: string;
  commands: ProceduralCommand[];
};

export type ProceduralRunResult = {
  ok: boolean;
  durationMs: number;
  commands: Array<{
    cmd: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
  }>;
};

type ProceduralStore = {
  version: number;
  entries: ProceduralEntry[];
};

const STORE_VERSION = 1;

const storePath = (store: string): string => path.join(store, "memory", "procedural.json");

const parseCommand = (value: string): string[] => {
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
};

const readStore = async (store: string): Promise<ProceduralStore> => {
  return (
    (await readJson<ProceduralStore>(storePath(store), {
      version: STORE_VERSION,
      entries: [],
    })) ?? { version: STORE_VERSION, entries: [] }
  );
};

const writeStore = async (store: string, data: ProceduralStore): Promise<void> => {
  const entries = data.entries.slice().sort((a, b) => {
    const createdDiff = a.createdAt.localeCompare(b.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  await writeJson(storePath(store), { version: STORE_VERSION, entries });
};

export const addProceduralEntry = async ({
  store,
  commands,
}: {
  store: string;
  commands: ProceduralCommand[];
}): Promise<ProceduralEntry> => {
  const createdAt = new Date().toISOString();
  const entry: ProceduralEntry = {
    id: `procedural-${createdAt.replace(/[:.]/g, "-")}`,
    version: STORE_VERSION,
    createdAt,
    commands,
  };
  const data = await readStore(store);
  data.entries.push(entry);
  await writeStore(store, data);
  return entry;
};

export const getProceduralEntry = async ({
  store,
  id,
}: {
  store: string;
  id: string;
}): Promise<ProceduralEntry | null> => {
  const data = await readStore(store);
  return data.entries.find((entry) => entry.id === id) ?? null;
};

export const runProceduralEntry = async ({
  root,
  entry,
}: {
  root: string;
  entry: ProceduralEntry;
}): Promise<ProceduralRunResult> => {
  const startedAt = Date.now();
  const commands: ProceduralRunResult["commands"] = [];
  let ok = true;

  for (const command of entry.commands) {
    if (command.stdinRequired && !command.input) {
      const error = new Error(
        `Procedural command requires stdin input but none was recorded: ${command.cmd}`,
      );
      (error as Error & { details?: unknown }).details = {
        cmd: command.cmd,
        reason: "stdin_required_missing",
      };
      throw error;
    }
    const args = parseCommand(command.cmd);
    const [bin, ...cmdArgs] = args;
    if (!bin) {
      ok = false;
      commands.push({
        cmd: command.cmd,
        cwd: command.cwd ?? root,
        exitCode: 1,
        durationMs: 0,
      });
      break;
    }
    const cwd = command.cwd ? path.resolve(root, command.cwd) : root;
    const env = command.env ? { ...process.env, ...command.env } : process.env;
    const start = Date.now();
    const stdio: StdioOptions = command.input
      ? ["pipe", "inherit", "inherit"]
      : "inherit";
    const exitCode = await new Promise<number>((resolve) => {
      const child: ChildProcess = spawn(bin, cmdArgs, { cwd, env, stdio });
      if (command.input && child.stdin) {
        child.stdin.write(command.input);
        child.stdin.end();
      }
      child.on("close", (code: number | null) => {
        resolve(code ?? 1);
      });
      child.on("error", () => resolve(1));
    });
    const durationMs = Date.now() - start;
    commands.push({ cmd: command.cmd, cwd, exitCode, durationMs });
    if (exitCode !== 0) {
      ok = false;
      break;
    }
  }

  return {
    ok,
    durationMs: Date.now() - startedAt,
    commands,
  };
};
