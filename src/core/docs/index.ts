import type {
  ComplianceReport,
  DocReference,
  MissingDocFinding,
} from "../contracts/compliance.js";

export type RemovedDocFinding = {
  command: string;
  subcommand: string | null;
  docRefs: DocReference[];
};

export type DocDeltaEntry = {
  path: string;
  missing: MissingDocFinding[];
  removed: RemovedDocFinding[];
};

export type DocDeltaReport = {
  files: DocDeltaEntry[];
  summary: {
    files: number;
    missing: number;
    removed: number;
  };
};

const sortMissing = (items: MissingDocFinding[]): MissingDocFinding[] =>
  items.slice().sort((a, b) => {
    const commandDiff = a.command.localeCompare(b.command);
    if (commandDiff !== 0) return commandDiff;
    const subDiff = String(a.subcommand ?? "").localeCompare(
      String(b.subcommand ?? ""),
    );
    if (subDiff !== 0) return subDiff;
    return a.id.localeCompare(b.id);
  });

const sortRemoved = (items: RemovedDocFinding[]): RemovedDocFinding[] =>
  items.slice().sort((a, b) => {
    const commandDiff = a.command.localeCompare(b.command);
    if (commandDiff !== 0) return commandDiff;
    return String(a.subcommand ?? "").localeCompare(String(b.subcommand ?? ""));
  });

export const buildDocDeltaReport = (
  report: ComplianceReport,
): DocDeltaReport => {
  const docPaths = [...report.docs.required, ...report.docs.optional].sort(
    (a, b) => a.localeCompare(b),
  );
  const entries = new Map<string, DocDeltaEntry>();
  for (const doc of docPaths) {
    entries.set(doc, { path: doc, missing: [], removed: [] });
  }

  for (const missing of report.missingDocs) {
    for (const doc of missing.missingIn) {
      const entry = entries.get(doc);
      if (entry) {
        entry.missing.push(missing);
      }
    }
  }

  for (const removed of report.removedExports) {
    const refsByDoc = new Map<string, DocReference[]>();
    for (const ref of removed.docRefs) {
      if (!refsByDoc.has(ref.path)) refsByDoc.set(ref.path, []);
      refsByDoc.get(ref.path)?.push(ref);
    }
    for (const [doc, refs] of refsByDoc.entries()) {
      const entry = entries.get(doc);
      if (!entry) continue;
      const sortedRefs = refs
        .slice()
        .sort((a, b) => a.line - b.line || a.column - b.column);
      entry.removed.push({
        command: removed.command,
        subcommand: removed.subcommand,
        docRefs: sortedRefs,
      });
    }
  }

  const files = Array.from(entries.values())
    .map((entry) => ({
      ...entry,
      missing: sortMissing(entry.missing),
      removed: sortRemoved(entry.removed),
    }))
    .filter((entry) => entry.missing.length > 0 || entry.removed.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  const summary = files.reduce(
    (acc, entry) => {
      acc.files += 1;
      acc.missing += entry.missing.length;
      acc.removed += entry.removed.length;
      return acc;
    },
    { files: 0, missing: 0, removed: 0 },
  );

  return { files, summary };
};
