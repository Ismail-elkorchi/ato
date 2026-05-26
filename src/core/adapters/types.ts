export type AdapterId = "node" | "python" | "php" | "research";

export type AdapterStatus = "enabled" | "disabled";

export type AdapterStepArtifact = {
  dir: string | null;
  gateId: string;
  tailLineLimit?: number;
};

export type AdapterExecuteStepInput = {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stream?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } | null;
  artifact?: AdapterStepArtifact | null;
  timeoutMs?: number;
};

export type AdapterExecuteStepResult = {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  commandLine: string;
  artifactPath: string | null;
};

export type CoreAdapter = {
  id: AdapterId;
  label: string;
  status: AdapterStatus;
  executeStep: (
    input: AdapterExecuteStepInput,
  ) => Promise<AdapterExecuteStepResult>;
};
