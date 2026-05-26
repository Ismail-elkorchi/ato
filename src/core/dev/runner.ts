import { spawn } from "node:child_process";
import path from "node:path";
import { createWriteStream, promises as fs } from "node:fs";

type DevRunResult = {
  ok: boolean;
  pid: number | null;
  ready: boolean;
  exitCode: number | null;
  durationMs: number;
  url: string;
  logPath: string | null;
  errorType: "timeout" | "port_in_use" | "process_exit" | "aborted" | null;
  errorMessage: string | null;
};

const parseCommand = (value: string): string[] => {
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForReady = async ({
  url,
  timeoutMs,
  intervalMs,
  isAlive,
}: {
  url: string;
  timeoutMs: number;
  intervalMs: number;
  isAlive: () => boolean;
}): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive()) return false;
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.status === 200) return true;
    } catch {
      // Ignore connection errors until timeout.
    }
    await sleep(intervalMs);
  }
  return false;
};

const PORT_IN_USE_PATTERN = /(EADDRINUSE|address already in use)/i;

export const runDevServer = async ({
  root,
  command,
  url,
  timeoutMs,
  intervalMs,
  artifactsDir,
}: {
  root: string;
  command: string;
  url: string;
  timeoutMs: number;
  intervalMs: number;
  artifactsDir: string | null;
}): Promise<DevRunResult> => {
  const args = parseCommand(command);
  const [bin, ...cmdArgs] = args;
  if (!bin) {
    return {
      ok: false,
      pid: null,
      ready: false,
      exitCode: 1,
      durationMs: 0,
      url,
      logPath: null,
      errorType: "process_exit",
      errorMessage: "Missing command.",
    };
  }

  const startedAt = Date.now();
  const logPath =
    artifactsDir ? path.join(artifactsDir, `dev-run-${Date.now()}.log`) : null;
  if (logPath) {
    await fs.mkdir(artifactsDir ?? root, { recursive: true });
  }

  const logStream = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  const appendLog = (chunk: Buffer) => {
    if (!logStream) return;
    logStream.write(chunk);
  };

  let outputTail = "";
  const updateTail = (chunk: Buffer) => {
    const next = outputTail + chunk.toString();
    outputTail = next.slice(Math.max(next.length - 20000, 0));
  };

  const child = spawn(bin, cmdArgs, { cwd: root });
  let exitCode: number | null = null;
  let exited = false;
  let aborted = false;

  const closePromise = new Promise<void>((resolve) => {
    child.on("close", (code: number | null) => {
      exitCode = code ?? 1;
      exited = true;
      resolve();
    });
  });

  child.stdout.on("data", (chunk: Buffer) => {
    updateTail(chunk);
    appendLog(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    updateTail(chunk);
    appendLog(chunk);
  });

  const stopChild = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const handleSignal = () => {
    aborted = true;
    stopChild();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let ready = false;
  let errorType: DevRunResult["errorType"] = null;
  let errorMessage: string | null = null;
  try {
    ready = await waitForReady({
      url,
      timeoutMs,
      intervalMs,
      isAlive: () => !exited && !aborted,
    });
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }

  if (aborted) {
    errorType = "aborted";
    errorMessage = "Interrupted by signal.";
  } else if (!ready) {
    if (exited) {
      errorType = PORT_IN_USE_PATTERN.test(outputTail)
        ? "port_in_use"
        : "process_exit";
      errorMessage =
        errorType === "port_in_use"
          ? "Server exited early: address already in use."
          : "Server exited before readiness.";
    } else {
      errorType = "timeout";
      errorMessage = `Timed out after ${timeoutMs}ms waiting for ${url}.`;
    }
  }

  if (!aborted) {
    stopChild();
  }

  const waitForExit = async (timeout: number) => {
    await Promise.race([closePromise, sleep(timeout)]);
  };

  await waitForExit(5000);
  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(2000);
  }
  if (logStream) {
    await new Promise<void>((resolve) => {
      logStream.end(() => resolve());
    });
  }

  const durationMs = Date.now() - startedAt;
  const ok = ready && !errorType;
  return {
    ok,
    pid: child.pid ?? null,
    ready,
    exitCode,
    durationMs,
    url,
    logPath,
    errorType,
    errorMessage,
  };
};

export type { DevRunResult };
