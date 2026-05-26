type ParseFlagsResult = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export const parseFlags = (args: string[]): ParseFlagsResult => {
  const result: ParseFlagsResult = { positionals: [], flags: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result.flags[key] = next;
        i += 1;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
};

export const formatTargetLine = (target: { id: string; root: string }): string =>
  `repo: ${target.id} root: ${target.root}`;

export const writeJson = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

export const writeLines = (lines: Array<string | null>): void => {
  process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
};

export const writeError = (
  {
    message,
    code,
    details,
  }: { message: string; code: number | string; details?: unknown },
  { json }: { json: boolean },
): void => {
  if (json) {
    if (code === "ATO_NOT_INITIALIZED") {
      const suggestedFix =
        details && typeof details === "object"
          ? (details as { suggested_fix?: string[] }).suggested_fix
          : null;
      if (Array.isArray(suggestedFix)) {
        writeJson({ ok: false, code, suggested_fix: suggestedFix });
        return;
      }
    }
    writeJson({ ok: false, code, error: { message, details } });
  } else {
    writeLines([
      `error: ${message}`,
      details ? JSON.stringify(details, null, 2) : null,
    ]);
  }
};
