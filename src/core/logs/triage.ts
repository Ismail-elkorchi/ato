type TriageKind = "eslint" | "node-test" | "generic";

export type TriageSummary = {
  kind: TriageKind;
  summary: string;
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
  test?: string;
};

const normalizeLines = (output: string): string[] =>
  output.split(/\r?\n/).map((line) => line.trimEnd());

const parseFileLocation = (
  value: string,
): { file: string; line: number; column: number } | null => {
  const match = value.match(/(.+):(\d+):(\d+)$/);
  if (!match) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  return { file: match[1] ?? "", line, column };
};

const parseEslint = (output: string): TriageSummary | null => {
  const lines = normalizeLines(output);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.startsWith("✖") || line.startsWith("error")) continue;
    const looksLikePath = /[\\/.]\w+/.test(line) && !line.startsWith(" ");
    if (!looksLikePath) continue;
    const next = lines[i + 1] ?? "";
    const match = next.match(/^\s*(\d+):(\d+)\s+error\s+(.+?)\s+([^\s]+)$/);
    if (!match) continue;
    const lineNum = Number(match[1]);
    const column = Number(match[2]);
    const message = match[3]?.trim() ?? "lint error";
    const rule = match[4]?.trim() ?? "unknown";
    const summary = `${line}:${lineNum}:${column} [${rule}] ${message}`;
    return {
      kind: "eslint",
      summary,
      file: line,
      line: lineNum,
      column,
      rule,
    };
  }
  return null;
};

const parseNodeTest = (output: string): TriageSummary | null => {
  const lines = normalizeLines(output);
  let testName: string | null = null;
  for (const line of lines) {
    const match = line.match(/^not ok\s+\d+\s+-\s+(.+)$/);
    if (match) {
      testName = match[1]?.trim() ?? null;
      break;
    }
  }
  if (!testName) return null;

  let location: { file: string; line: number; column: number } | null = null;
  for (const line of lines) {
    const locMatch = line.match(/location:\s+'(.+)'/);
    if (locMatch) {
      location = parseFileLocation(locMatch[1] ?? "");
      if (location) break;
    }
  }

  if (!location) {
    for (const line of lines) {
      const match = line.match(/\s+at\s+(.+:\d+:\d+)\b/);
      if (match) {
        location = parseFileLocation(match[1] ?? "");
        if (location) break;
      }
    }
  }

  const summary = location
    ? `test "${testName}" at ${location.file}:${location.line}:${location.column}`
    : `test "${testName}" failed`;

  return {
    kind: "node-test",
    summary,
    test: testName,
    ...(location ?? {}),
  };
};

const parseGeneric = (output: string): TriageSummary | null => {
  const lines = normalizeLines(output);
  for (const line of lines) {
    if (!line) continue;
    const loc = parseFileLocation(line);
    if (loc) {
      return {
        kind: "generic",
        summary: `${loc.file}:${loc.line}:${loc.column}`,
        ...loc,
      };
    }
    if (/error|failed/i.test(line)) {
      return { kind: "generic", summary: line };
    }
  }
  return null;
};

export const triageGateOutput = ({
  id,
  command,
  stdout,
  stderr,
}: {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
}): TriageSummary | null => {
  const output = `${stdout}\n${stderr}`;
  const hint = `${id} ${command}`.toLowerCase();
  if (hint.includes("lint") || hint.includes("eslint")) {
    return parseEslint(output) ?? parseGeneric(output);
  }
  if (hint.includes("test") || hint.includes("node --test")) {
    return parseNodeTest(output) ?? parseGeneric(output);
  }
  return parseGeneric(output);
};
