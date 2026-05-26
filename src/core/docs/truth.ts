import path from "node:path";
import { promises as fs } from "node:fs";

export const DOCS_TRUTH_SCHEMA_VERSION = "docs-truth-report.v1";

const TRUTH_SECTION_HEADING_RE = /^##\s+Truth Claims\s*$/i;
const SECOND_LEVEL_HEADING_RE = /^##\s+/;
const BULLET_RE = /^\s*-\s+/;
const CLAIM_RE =
  /^\s*-\s+\[(implemented|planned|unknown)\]\s+(.+?)(?:\s+\|\s+evidence:\s*(.+))?\s*$/i;

export const MAJOR_DOCS = [
  "README.md",
  "docs/USER_GUIDE.md",
  "docs/LLM_GUIDE.md",
  "docs/CAPABILITY_GUIDE.md",
  "docs/PLUGIN_GUIDE.md",
] as const;

export type DocsTruthLabel = "implemented" | "planned" | "unknown";

export type DocsTruthClaim = {
  id: string;
  doc: string;
  line: number;
  label: DocsTruthLabel;
  statement: string;
  evidence: string[];
  has_test_evidence: boolean;
};

export type DocsTruthIssue = {
  code:
    | "missing_truth_section"
    | "missing_label"
    | "implemented_missing_evidence"
    | "implemented_missing_code_evidence"
    | "evidence_path_missing";
  level: "error" | "warn";
  doc: string;
  line: number | null;
  message: string;
  claim_id: string | null;
};

type DocsTruthDocReport = {
  path: string;
  claims: DocsTruthClaim[];
  counts: Record<DocsTruthLabel, number>;
  issues: DocsTruthIssue[];
};

export type DocsTruthReport = {
  ok: boolean;
  schema_version: typeof DOCS_TRUTH_SCHEMA_VERSION;
  docs: DocsTruthDocReport[];
  summary: {
    docs: number;
    claims: number;
    implemented: number;
    planned: number;
    unknown: number;
    errors: number;
    warnings: number;
  };
  issues: DocsTruthIssue[];
};

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const normalizeEvidencePath = (value: string): string => {
  const trimmed = value.trim().replace(/^`|`$/g, "");
  const withoutPrefix = trimmed.replace(/^file:/i, "");
  const withoutDotSlash = withoutPrefix.startsWith("./")
    ? withoutPrefix.slice(2)
    : withoutPrefix;
  return toPosix(withoutDotSlash);
};

const parseEvidenceList = (raw: string | null): string[] => {
  if (!raw) return [];
  const parts = raw
    .split(/[;,]/)
    .map((entry) => normalizeEvidencePath(entry))
    .filter(Boolean);
  return Array.from(new Set(parts)).sort((a, b) => a.localeCompare(b));
};

const isCodeEvidence = (entry: string): boolean =>
  entry.startsWith("src/") || entry.startsWith("scripts/");

const isTestEvidence = (entry: string): boolean => entry.startsWith("test/");

const readFileOrEmpty = async (absolutePath: string): Promise<string> =>
  fs.readFile(absolutePath, "utf8").catch(() => "");

const pathExists = async (absolutePath: string): Promise<boolean> => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

const parseDocClaims = ({
  docPath,
  content,
}: {
  docPath: string;
  content: string;
}): {
  claims: DocsTruthClaim[];
  issues: DocsTruthIssue[];
} => {
  const lines = content.split(/\r?\n/);
  const claims: DocsTruthClaim[] = [];
  const issues: DocsTruthIssue[] = [];
  let inTruthSection = false;
  let sawTruthSection = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    if (TRUTH_SECTION_HEADING_RE.test(line)) {
      inTruthSection = true;
      sawTruthSection = true;
      continue;
    }
    if (inTruthSection && SECOND_LEVEL_HEADING_RE.test(line)) {
      inTruthSection = false;
    }
    if (!inTruthSection) continue;
    if (!BULLET_RE.test(line)) continue;

    const claimMatch = line.match(CLAIM_RE);
    if (!claimMatch) {
      issues.push({
        code: "missing_label",
        level: "error",
        doc: docPath,
        line: idx + 1,
        message:
          "Truth claim bullets must start with [implemented], [planned], or [unknown].",
        claim_id: null,
      });
      continue;
    }

    const label = (claimMatch[1] ?? "").toLowerCase() as DocsTruthLabel;
    const statement = String(claimMatch[2] ?? "").trim();
    const evidence = parseEvidenceList(claimMatch[3] ?? null);
    const claimId = `${docPath}#L${idx + 1}`;
    claims.push({
      id: claimId,
      doc: docPath,
      line: idx + 1,
      label,
      statement,
      evidence,
      has_test_evidence: evidence.some((entry) => isTestEvidence(entry)),
    });

    if (label === "implemented" && evidence.length === 0) {
      issues.push({
        code: "implemented_missing_evidence",
        level: "error",
        doc: docPath,
        line: idx + 1,
        message: "Implemented claims must include evidence pointers.",
        claim_id: claimId,
      });
    }
    if (label === "implemented" && !evidence.some((entry) => isCodeEvidence(entry))) {
      issues.push({
        code: "implemented_missing_code_evidence",
        level: "error",
        doc: docPath,
        line: idx + 1,
        message:
          "Implemented claims must include at least one code evidence path (src/ or scripts/).",
        claim_id: claimId,
      });
    }
  }

  if (!sawTruthSection) {
    issues.push({
      code: "missing_truth_section",
      level: "error",
      doc: docPath,
      line: null,
      message: "Missing `## Truth Claims` section.",
      claim_id: null,
    });
  }

  return { claims, issues };
};

const sortIssues = (items: DocsTruthIssue[]): DocsTruthIssue[] =>
  items.slice().sort((a, b) => {
    const docDiff = a.doc.localeCompare(b.doc);
    if (docDiff !== 0) return docDiff;
    const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
    const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
    if (lineA !== lineB) return lineA - lineB;
    const codeDiff = a.code.localeCompare(b.code);
    if (codeDiff !== 0) return codeDiff;
    return a.message.localeCompare(b.message);
  });

export const buildDocsTruthReport = async ({
  root,
  docs = MAJOR_DOCS,
}: {
  root: string;
  docs?: readonly string[];
}): Promise<DocsTruthReport> => {
  const normalizedDocs = Array.from(new Set(docs.map((entry) => toPosix(entry))))
    .sort((a, b) => a.localeCompare(b));
  const docReports: DocsTruthDocReport[] = [];
  const allIssues: DocsTruthIssue[] = [];

  for (const docPath of normalizedDocs) {
    const absolutePath = path.join(root, docPath);
    const content = await readFileOrEmpty(absolutePath);
    const { claims, issues } = parseDocClaims({ docPath, content });
    const docIssues = [...issues];
    for (const claim of claims) {
      for (const evidence of claim.evidence) {
        const absoluteEvidence = path.join(root, evidence);
        const exists = await pathExists(absoluteEvidence);
        if (!exists) {
          docIssues.push({
            code: "evidence_path_missing",
            level: "error",
            doc: docPath,
            line: claim.line,
            message: `Evidence path does not exist: ${evidence}`,
            claim_id: claim.id,
          });
        }
      }
    }

    const counts: Record<DocsTruthLabel, number> = {
      implemented: claims.filter((claim) => claim.label === "implemented").length,
      planned: claims.filter((claim) => claim.label === "planned").length,
      unknown: claims.filter((claim) => claim.label === "unknown").length,
    };
    const sortedClaims = claims.sort(
      (a, b) => a.line - b.line || a.id.localeCompare(b.id),
    );
    const sortedIssues = sortIssues(docIssues);
    docReports.push({
      path: docPath,
      claims: sortedClaims,
      counts,
      issues: sortedIssues,
    });
    allIssues.push(...sortedIssues);
  }

  const sortedDocs = docReports.sort((a, b) => a.path.localeCompare(b.path));
  const sortedIssues = sortIssues(allIssues);
  const errors = sortedIssues.filter((issue) => issue.level === "error").length;
  const warnings = sortedIssues.filter((issue) => issue.level === "warn").length;
  const summary = sortedDocs.reduce(
    (acc, doc) => {
      acc.docs += 1;
      acc.claims += doc.claims.length;
      acc.implemented += doc.counts.implemented;
      acc.planned += doc.counts.planned;
      acc.unknown += doc.counts.unknown;
      return acc;
    },
    {
      docs: 0,
      claims: 0,
      implemented: 0,
      planned: 0,
      unknown: 0,
      errors,
      warnings,
    },
  );
  summary.errors = errors;
  summary.warnings = warnings;

  return {
    ok: errors === 0,
    schema_version: DOCS_TRUTH_SCHEMA_VERSION,
    docs: sortedDocs,
    summary,
    issues: sortedIssues,
  };
};
