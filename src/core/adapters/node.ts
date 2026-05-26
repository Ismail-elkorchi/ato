import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

import type {
  AdapterExecuteStepInput,
  AdapterExecuteStepResult,
  CoreAdapter,
} from "./types.js";

const TAIL_LINE_LIMIT = 200;

type TailSnapshot = {
  text: string;
  total: number;
  lines: number;
};

const normalizeLines = (value: string): string[] => {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

const buildTailSnapshot = (value: string, limit: number): TailSnapshot => {
  const lines = normalizeLines(value);
  const total = lines.length;
  const tailLines = total > limit ? lines.slice(total - limit) : lines;
  return {
    text: tailLines.join("\n"),
    total,
    lines: tailLines.length,
  };
};

const formatTailSection = (label: string, snapshot: TailSnapshot): string => {
  const body = snapshot.text.length ? snapshot.text : "(empty)";
  return `${label} (tail ${snapshot.lines}/${snapshot.total} lines)\n${body}`;
};

const runCommand = async ({
  cmd,
  cwd,
  env,
  stream,
  timeoutMs,
}: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stream?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } | null;
  timeoutMs?: number;
}): Promise<AdapterExecuteStepResult> => {
  const [bin, ...args] = cmd;
  if (!bin) {
    return {
      ok: false,
      exitCode: 1,
      durationMs: 0,
      stdout: "",
      stderr: "Missing command.",
      commandLine: "",
      artifactPath: null,
    };
  }
  const start = Date.now();
  return await new Promise((resolve) => {
    const useDetached = process.platform !== "win32";
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(useDetached ? { detached: true } : {}),
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let killHandle: NodeJS.Timeout | null = null;
    const killProcess = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (useDetached) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall through to direct kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore kill errors for already-exited processes
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
      stream?.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      stream?.stderr.write(chunk);
    });
    child.on("close", (code: number | null) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const timedOutMessage =
        timedOut && timeoutMs && timeoutMs > 0
          ? `Timed out after ${timeoutMs}ms.`
          : null;
      const finalStderr =
        timedOutMessage && !stderr.includes(timedOutMessage)
          ? `${stderr}${stderr ? "\n" : ""}${timedOutMessage}`
          : stderr;
      resolve({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? 124 : code ?? 1,
        durationMs: Date.now() - start,
        stdout,
        stderr: finalStderr,
        commandLine: [bin, ...args].join(" "),
        artifactPath: null,
      });
    });
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (!child.killed) {
          killProcess("SIGTERM");
          killHandle = setTimeout(() => {
            if (!child.killed) killProcess("SIGKILL");
          }, 250);
        }
      }, timeoutMs);
    }
  });
};

const writeArtifact = async ({
  artifact,
  result,
}: {
  artifact?: AdapterExecuteStepInput["artifact"];
  result: AdapterExecuteStepResult;
}): Promise<string | null> => {
  const dir = artifact?.dir ?? null;
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${artifact?.gateId ?? "gate"}-${Date.now()}.log`;
  const artifactPath = path.join(dir, fileName);
  const limit = artifact?.tailLineLimit ?? TAIL_LINE_LIMIT;
  const stdoutTail = buildTailSnapshot(result.stdout, limit);
  const stderrTail = buildTailSnapshot(result.stderr, limit);
  const content = [
    `# Gate ${artifact?.gateId ?? "unknown"}`,
    `Command: ${result.commandLine}`,
    `Exit: ${result.exitCode}`,
    `DurationMs: ${result.durationMs}`,
    "",
    formatTailSection("stdout", stdoutTail),
    "",
    formatTailSection("stderr", stderrTail),
  ].join("\n");
  await fs.writeFile(artifactPath, content, "utf8");
  return artifactPath;
};

export const nodeAdapter: CoreAdapter = {
  id: "node",
  label: "Node",
  status: "enabled",
  executeStep: async (input) => {
    const result = await runCommand(input);
    const artifactPath = await writeArtifact({ artifact: input.artifact, result });
    return { ...result, artifactPath };
  },
};
