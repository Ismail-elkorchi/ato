import { spawn } from "node:child_process";
import path from "node:path";

import { writeJson } from "../fs.js";
import type { JsonObject } from "../types.js";

type TraceEvent = {
  seq: number;
  ts: string;
  category: string;
  name: string;
  data?: JsonObject;
};

type TraceError = {
  type: "missing_command" | "spawn" | "exit" | "signal";
  message: string;
  code?: string | null;
};

type TraceSummary = {
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  eventCount: number;
};

type TraceOutput = {
  version: 1;
  id: string;
  createdAt: string;
  command: string;
  cwd: string;
  filters: { categories: string[] | null };
  categories: string[];
  events: TraceEvent[];
  summary: TraceSummary;
};

type TraceResult = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  tracePath: string | null;
  trace: TraceOutput;
  error: TraceError | null;
};

type TraceStdio = "inherit" | "ignore";

const parseCommand = (value: string): string[] => {
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
};

const normalizeCategories = (
  categories: string[] | null | undefined,
): string[] => {
  if (!categories || categories.length === 0) return [];
  const normalized = categories
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
};

const collectCategories = (events: TraceEvent[]): string[] => {
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.category);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
};

class TraceRecorder {
  private seq = 1;
  private events: TraceEvent[] = [];
  private categoryFilter: Set<string> | null;

  constructor(categories: string[]) {
    this.categoryFilter = categories.length ? new Set(categories) : null;
  }

  record({
    category,
    name,
    data,
  }: {
    category: string;
    name: string;
    data?: JsonObject;
  }): void {
    if (this.categoryFilter && !this.categoryFilter.has(category)) {
      return;
    }
    this.events.push({
      seq: this.seq,
      ts: new Date().toISOString(),
      category,
      name,
      ...(data === undefined ? {} : { data }),
    });
    this.seq += 1;
  }

  list(): TraceEvent[] {
    return this.events;
  }
}

export const runTracedCommand = async ({
  root,
  command,
  categories,
  artifactsDir,
  stdio = "inherit",
}: {
  root: string;
  command: string;
  categories?: string[] | null;
  artifactsDir: string | null;
  stdio?: TraceStdio;
}): Promise<TraceResult> => {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const traceId = `trace-${startedAt}`;
  const normalizedCategories = normalizeCategories(categories);
  const recorder = new TraceRecorder(normalizedCategories);

  recorder.record({
    category: "trace",
    name: "start",
    data: {
      command,
      cwd: root,
      filters: normalizedCategories.length ? normalizedCategories : null,
    },
  });

  let exitCode: number | null = null;
  let signal: string | null = null;
  let error: TraceError | null = null;

  const args = parseCommand(command);
  const [bin, ...cmdArgs] = args;
  if (!bin) {
    error = { type: "missing_command", message: "Missing command." };
    recorder.record({
      category: "command",
      name: "error",
      data: { message: error.message },
    });
  } else {
    const child = spawn(bin, cmdArgs, { cwd: root, stdio });
    recorder.record({
      category: "command",
      name: "start",
      data: {
        pid: child.pid ?? null,
        bin,
        args: cmdArgs,
      },
    });

    const result = await new Promise<{
      code: number | null;
      signal: string | null;
      error: NodeJS.ErrnoException | null;
    }>((resolve) => {
      let finished = false;
      const finish = (payload: {
        code: number | null;
        signal: string | null;
        error: NodeJS.ErrnoException | null;
      }) => {
        if (finished) return;
        finished = true;
        resolve(payload);
      };
      child.on("close", (code: number | null, received: NodeJS.Signals | null) => {
        finish({ code: code ?? null, signal: received ?? null, error: null });
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish({ code: 1, signal: null, error: err });
      });
    });

    if (result.error) {
      error = {
        type: "spawn",
        message: result.error.message,
        code: result.error.code ?? null,
      };
      exitCode = 1;
      recorder.record({
        category: "command",
        name: "error",
        data: {
          message: result.error.message,
          code: result.error.code ?? null,
        },
      });
    } else {
      exitCode = result.code ?? 0;
      signal = result.signal ?? null;
      recorder.record({
        category: "command",
        name: "exit",
        data: { exitCode, signal },
      });
      if (signal) {
        error = {
          type: "signal",
          message: `Command terminated by ${signal}.`,
          code: signal,
        };
      } else if (exitCode !== 0) {
        error = {
          type: "exit",
          message: `Command exited with code ${exitCode}.`,
        };
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  recorder.record({
    category: "trace",
    name: "end",
    data: { durationMs },
  });

  const events = recorder.list();
  const summary: TraceSummary = {
    ok: !error && exitCode === 0,
    durationMs,
    exitCode,
    signal,
    eventCount: events.length,
  };

  const trace: TraceOutput = {
    version: 1,
    id: traceId,
    createdAt: startedAtIso,
    command,
    cwd: root,
    filters: {
      categories: normalizedCategories.length ? normalizedCategories : null,
    },
    categories: collectCategories(events),
    events,
    summary,
  };

  const tracePath = artifactsDir ? path.join(artifactsDir, `${traceId}.json`) : null;
  if (tracePath) {
    await writeJson(tracePath, trace);
  }

  return {
    ok: summary.ok,
    exitCode,
    signal,
    durationMs,
    tracePath,
    trace,
    error,
  };
};

export type { TraceEvent, TraceOutput, TraceResult, TraceError };
