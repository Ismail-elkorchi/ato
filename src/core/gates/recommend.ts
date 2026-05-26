import { spawn } from "node:child_process";

type RiskRule = {
  id: string;
  label: string;
  description: string;
  mode: "fast" | "full";
  match: (filePath: string) => boolean;
};

export type GateRecommendation = {
  mode: "fast" | "full";
  rationale: string;
  risks: string[];
  touched: string[];
  changedFiles: string[];
  rules: Array<{
    id: string;
    label: string;
    description: string;
    mode: "fast" | "full";
    matches: string[];
  }>;
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const readChangedFiles = async (root: string): Promise<string[]> =>
  new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: root });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const files: string[] = [];
      for (const line of lines) {
        const raw = line.slice(3).trim();
        if (!raw) continue;
        if (raw.includes(" -> ")) {
          const renamed = raw.split(" -> ").pop();
          if (renamed) files.push(normalizePath(renamed.trim()));
        } else {
          files.push(normalizePath(raw));
        }
      }
      files.sort((a, b) => a.localeCompare(b));
      resolve(files);
    });
  });

const ruleMatches = (rule: RiskRule, files: string[]): string[] =>
  files.filter((file) => rule.match(file));

const surfaceFor = (filePath: string): string => {
  const normalized = normalizePath(filePath);
  const [head] = normalized.split("/");
  return head || normalized;
};

const RULES: RiskRule[] = [
  {
    id: "exports",
    label: "Public surface",
    description: "Entrypoints, export lists, or public API files changed.",
    mode: "full",
    match: (filePath) =>
      filePath === "package.json" ||
      /(^|\/)(index|main|exports)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
      /(^|\/)public\.(ts|js|mjs|cjs)$/.test(filePath) ||
      /(^|\/)types?\.(ts|d\.ts)$/.test(filePath),
  },
  {
    id: "tests",
    label: "Tests",
    description: "Test files or fixtures changed.",
    mode: "full",
    match: (filePath) =>
      /(^|\/)(test|tests|__tests__|__fixtures__)(\/|$)/.test(filePath) ||
      /(\.|\/)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath),
  },
  {
    id: "tokens",
    label: "Tokens",
    description: "Design tokens or theme sources changed.",
    mode: "full",
    match: (filePath) =>
      /(^|\/)(tokens?|themes?)(\/|$)/.test(filePath) ||
      /(^|\/)(tokens?|themes?)\.(ts|js|json|css)$/.test(filePath) ||
      /(^|\/)styles\.(css|scss)$/.test(filePath),
  },
  {
    id: "tooling",
    label: "Tooling",
    description: "Build, lint, or automation configs changed.",
    mode: "full",
    match: (filePath) =>
      /(^|\/)scripts(\/|$)/.test(filePath) ||
      /(^|\/)\.github(\/|$)/.test(filePath) ||
      /(^|\/)\.husky(\/|$)/.test(filePath) ||
      /(^|\/)(package|package-lock|pnpm-lock|yarn)\.(json|yaml|yml)$/.test(
        filePath,
      ) ||
      /(^|\/)tsconfig\..+\.json$/.test(filePath) ||
      /(^|\/)(eslint|prettier|stylelint)\./.test(filePath) ||
      /(^|\/)(vite|rollup|webpack|babel|postcss)\.config\./.test(filePath) ||
      /(^|\/)(Makefile|Dockerfile)$/.test(filePath),
  },
];

export const recommendGateMode = async ({
  root,
  changedFiles,
}: {
  root: string;
  changedFiles?: string[];
}): Promise<GateRecommendation> => {
  const files = changedFiles
    ? changedFiles.map(normalizePath).sort((a, b) => a.localeCompare(b))
    : await readChangedFiles(root);

  const touched = [...new Set(files.map(surfaceFor))].sort((a, b) =>
    a.localeCompare(b),
  );

  const rules = RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    description: rule.description,
    mode: rule.mode,
    matches: ruleMatches(rule, files),
  }));

  const triggered = rules.filter((rule) => rule.matches.length > 0);
  const risks = triggered.map((rule) => rule.id);
  const mode: "fast" | "full" = risks.length ? "full" : "fast";
  const rationale = risks.length
    ? `Risk triggers: ${risks.join(", ")}`
    : "No risk triggers detected.";

  return {
    mode,
    rationale,
    risks,
    touched,
    changedFiles: files,
    rules: triggered,
  };
};
