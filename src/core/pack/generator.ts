import { countTokens } from "../tokens.js";
import type {
  BlackboardSignal,
  LessonItem,
  PatternItem,
  QueueItem,
  RunLogEntry,
} from "../types.js";
import type { ContractEntry } from "../contracts/index.js";

type PackFormat = "md" | "json";
type PackMeta = {
  task: string;
  focus: string | null;
  budget: number;
  queueId: string | null;
};

type PackUnit = {
  id: string;
  label: string;
  groupId: string;
  groupTitle: string;
  groupOrder?: number;
  order?: number;
  content: string;
  citations?: PackCitation[];
  canDrop: boolean;
  utility: number;
  tokenCost?: number;
};

type PackGroup = {
  id: string;
  title: string;
  order: number;
  units: string[];
};

type PackSection = { entry: ContractEntry; content: string; docPath: string };

type PackRouters = {
  root?: { path?: string; content: string };
  scoped?: { path: string; content: string } | null;
} | null;

type PackOutput = {
  overBudget: boolean;
  output: string;
  tokens?: number;
  requiredTokens?: number;
  gaps?: PackGap[];
};

type PackCitation = {
  path: string;
  lineStart: number;
  lineEnd?: number | null;
  label?: string;
};

type PackGap = {
  id: string;
  label: string;
  groupId: string;
  groupTitle: string;
  tokenCost: number;
  utility: number;
  canDrop: boolean;
};

type PackCitationGroup = {
  unitId: string;
  label: string;
  groupId: string;
  groupTitle: string;
  citations: PackCitation[];
};

const countLines = (content: string): number => {
  if (!content) return 1;
  return content.split(/\r?\n/).length;
};

const formatCitation = (citation: PackCitation): string => {
  const end =
    citation.lineEnd && citation.lineEnd !== citation.lineStart
      ? `-${citation.lineEnd}`
      : "";
  const label = citation.label ? ` (${citation.label})` : "";
  return `- ${citation.path}:${citation.lineStart}${end}${label}`;
};

const formatUnitContent = ({
  unit,
  format,
  withCitations,
}: {
  unit: PackUnit;
  format: PackFormat;
  withCitations: boolean;
}): string => {
  if (format !== "md" || !withCitations || !unit.citations?.length) {
    return unit.content;
  }
  return [
    unit.content,
    "",
    "Citations:",
    ...unit.citations.map(formatCitation),
  ].join("\n");
};

const buildLineCitation = ({
  path,
  lineStart,
  lineEnd,
  label,
}: {
  path: string | null | undefined;
  lineStart: number | null | undefined;
  lineEnd?: number | null;
  label?: string;
}): PackCitation[] | undefined => {
  if (!path || typeof lineStart !== "number" || lineStart <= 0) return undefined;
  return [
    {
      path,
      lineStart,
      lineEnd: typeof lineEnd === "number" ? lineEnd : lineStart,
      ...(label ? { label } : {}),
    },
  ];
};

const renderMarkdown = ({
  meta,
  groups,
  gaps,
}: {
  meta: PackMeta;
  groups: PackGroup[];
  gaps: PackGap[];
}): string => {
  const lines = [
    "# Context Pack",
    `- task: ${meta.task ?? "unspecified"}`,
    `- budget: ${meta.budget} tokens`,
    meta.focus ? `- focus: ${meta.focus}` : null,
    meta.queueId ? `- queue: ${meta.queueId}` : null,
  ].filter(Boolean);

  for (const group of groups) {
    const content = group.units.join("\n\n").trim();
    if (!content) continue;
    lines.push(`\n## ${group.title}`);
    lines.push(content);
  }

  if (gaps.length) {
    lines.push("\n## Gaps");
    lines.push("The following items could not fit within the budget:");
    for (const gap of gaps) {
      lines.push(
        `- ${gap.label} (${gap.groupTitle}) [tokens: ${gap.tokenCost}, utility: ${gap.utility}]`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
};

const renderJson = ({
  meta,
  groups,
  citations,
  gaps,
}: {
  meta: PackMeta;
  groups: PackGroup[];
  citations: PackCitationGroup[];
  gaps: PackGap[];
}): string => {
  const payload = {
    meta,
    sections: groups.reduce((acc, group) => {
      const content = group.units.join("\n\n").trim();
      if (content) {
        acc[group.id] = content;
      }
      return acc;
    }, {} as Record<string, string>),
    citations,
    gaps,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
};

const buildOutput = ({
  format,
  meta,
  units,
  includedIds,
  withCitations,
  gaps,
}: {
  format: PackFormat;
  meta: PackMeta;
  units: PackUnit[];
  includedIds: Set<string>;
  withCitations: boolean;
  gaps: PackGap[];
}): { output: string; citations: PackCitationGroup[] } => {
  const groupMap = new Map<
    string,
    { id: string; title: string; order: number; units: PackUnit[] }
  >();

  for (const unit of units) {
    if (!includedIds.has(unit.id)) continue;
    if (!groupMap.has(unit.groupId)) {
      groupMap.set(unit.groupId, {
        id: unit.groupId,
        title: unit.groupTitle,
        order: unit.groupOrder ?? 0,
        units: [],
      });
    }
    groupMap.get(unit.groupId)?.units.push(unit);
  }

  const citations: PackCitationGroup[] = [];

  const groups = [...groupMap.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((group) => ({
      ...group,
      units: group.units
        .sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
        )
        .map((unit) => {
          if (withCitations && unit.citations?.length) {
            citations.push({
              unitId: unit.id,
              label: unit.label,
              groupId: unit.groupId,
              groupTitle: unit.groupTitle,
              citations: unit.citations,
            });
          }
          return formatUnitContent({ unit, format, withCitations });
        }),
    }));

  const output =
    format === "json"
      ? renderJson({
          meta,
          groups,
          citations: withCitations ? citations : [],
          gaps,
        })
      : renderMarkdown({ meta, groups, gaps });
  return { output, citations };
};

const tokenizeKeywords = (text: unknown): string[] => {
  if (!text) return [];
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  return [...new Set(tokens)];
};

const scoreMatches = (keywords: string[], text: unknown): number => {
  if (!keywords.length || !text) return 0;
  const haystack = String(text).toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 1;
  }
  return score;
};

const formatRouter = (label: string, content: unknown): string =>
  `${label}\n\n${String(content ?? "").trim()}`;

const formatQueueItem = (item: QueueItem): string =>
  `${JSON.stringify(item, null, 2)}`;

const formatSignals = (signal: BlackboardSignal): string =>
  `- ${signal.ts ?? "unknown"}: ${signal.summary ?? ""}`.trim();

const formatLessonItem = (lesson: LessonItem): string =>
  `- ${lesson.id}: ${lesson.pattern} (prevention: ${lesson.prevention})`;

const formatPatternItem = (pattern: PatternItem): string =>
  `- ${pattern.id}: ${pattern.title} (${pattern.kind})`;

const formatContractSections = (sections: PackSection[]): string => {
  if (!sections?.length) return "";
  return sections
    .map((section) => `### ${section.entry.heading}\n\n${section.content}`)
    .join("\n\n");
};

const formatNextActions = (actions: string[]): string =>
  actions.map((action) => `- ${action}`).join("\n");

const collectRecentRefs = (
  runLogEntries: RunLogEntry[],
  queueId: string | null,
): { lessonIds: Set<string>; patternIds: Set<string> } => {
  if (!queueId) {
    return { lessonIds: new Set(), patternIds: new Set() };
  }
  const recent = runLogEntries
    .filter((entry) => entry.queue_id === queueId)
    .slice(-20);
  const lessonIds = new Set<string>();
  const patternIds = new Set<string>();
  for (const entry of recent) {
    for (const lessonId of entry.lesson_ids ?? []) {
      lessonIds.add(lessonId);
    }
    for (const patternId of entry.pattern_ids ?? []) {
      patternIds.add(patternId);
    }
  }
  return { lessonIds, patternIds };
};

const hasRecentFailures = (
  runLogEntries: RunLogEntry[],
  queueId: string | null,
): boolean => {
  if (!queueId) return false;
  const recent = runLogEntries
    .filter((entry) => entry.queue_id === queueId && entry.kind === "gate_run")
    .slice(-5);
  return recent.some((entry) => {
    if (String(entry.summary ?? "").includes("fail")) return true;
    return (entry.commands ?? []).some((command) => command.exitCode !== 0);
  });
};

const buildNextActions = (
  queueItem: QueueItem | null,
  runLogEntries: RunLogEntry[],
): string[] => {
  if (!queueItem) return [];
  const actions: string[] = [];
  const openNeeds = (queueItem.details?.needs ?? []).filter(
    (need) => need.status === "open",
  );
  for (const need of openNeeds) {
    const ask = String(need.ask ?? "").trim();
    if (!ask) continue;
    actions.push(`Resolve ${need.kind} need: ${ask}`);
  }
  if (hasRecentFailures(runLogEntries, queueItem.id)) {
    actions.push("Investigate recent gate failures and update the runbook.");
    actions.push("Consider: ato lesson add --input <json|path>");
  }
  return actions;
};

const applyTokenBudget = ({
  format,
  budget,
  meta,
  units,
  withCitations,
}: {
  format: PackFormat;
  budget: number;
  meta: PackMeta;
  units: PackUnit[];
  withCitations: boolean;
}): PackOutput => {
  const prepared = units.map((unit) => ({
    ...unit,
    tokenCost: Math.max(
      1,
      countTokens(formatUnitContent({ unit, format, withCitations })),
    ),
  }));
  const essentialUnits = prepared.filter((unit) => !unit.canDrop);
  const optionalUnits = prepared.filter(
    (unit) => unit.canDrop && unit.utility > 0,
  );

  const toGaps = (included: Set<string>): PackGap[] =>
    prepared
      .filter((unit) => !included.has(unit.id))
      .map((unit) => ({
        id: unit.id,
        label: unit.label,
        groupId: unit.groupId,
        groupTitle: unit.groupTitle,
        tokenCost: unit.tokenCost ?? 0,
        utility: unit.utility,
        canDrop: unit.canDrop,
      }));

  const buildAttempt = (included: Set<string>) => {
    const gaps = toGaps(included);
    const attempt = buildOutput({
      format,
      meta,
      units: prepared,
      includedIds: included,
      withCitations,
      gaps,
    });
    return {
      output: attempt.output,
      tokens: countTokens(attempt.output),
      gaps,
    };
  };

  const includedIds = new Set(essentialUnits.map((unit) => unit.id));
  let attempt = buildAttempt(includedIds);

  if (attempt.tokens > budget) {
    return {
      overBudget: true,
      requiredTokens: attempt.tokens,
      output: attempt.output,
      gaps: attempt.gaps,
    };
  }

  const sorted = [...optionalUnits].sort((a, b) => {
    const ratioA = a.utility / a.tokenCost;
    const ratioB = b.utility / b.tokenCost;
    if (ratioA !== ratioB) return ratioB - ratioA;
    if (a.utility !== b.utility) return b.utility - a.utility;
    if (a.tokenCost !== b.tokenCost) return a.tokenCost - b.tokenCost;
    return a.id.localeCompare(b.id);
  });

  for (const unit of sorted) {
    includedIds.add(unit.id);
    const nextAttempt = buildAttempt(includedIds);
    if (nextAttempt.tokens <= budget) {
      attempt = nextAttempt;
    } else {
      includedIds.delete(unit.id);
    }
  }

  return {
    overBudget: false,
    output: attempt.output,
    tokens: attempt.tokens,
    gaps: attempt.gaps,
  };
};

export const buildPack = ({
  task,
  focus,
  budget,
  format,
  queueItem,
  queueLine,
  queuePath,
  routers,
  contractSections,
  blackboardSignals,
  lessons,
  lessonLineMap,
  lessonSourcePath,
  patterns,
  patternLineMap,
  patternSourcePath,
  runLogEntries,
  withCitations = false,
}: {
  task: string;
  focus: string | null;
  budget: number;
  format: PackFormat;
  queueItem: QueueItem | null;
  queueLine?: number | null;
  queuePath?: string | null;
  routers: PackRouters;
  contractSections: PackSection[];
  blackboardSignals: BlackboardSignal[];
  lessons: LessonItem[];
  lessonLineMap?: Record<string, number>;
  lessonSourcePath?: string | null;
  patterns: PatternItem[];
  patternLineMap?: Record<string, number>;
  patternSourcePath?: string | null;
  runLogEntries: RunLogEntry[];
  withCitations?: boolean;
}): PackOutput => {
  const runEntries = Array.isArray(runLogEntries) ? runLogEntries : [];
  const meta = {
    task,
    focus,
    budget,
    queueId: queueItem?.id ?? null,
  };

  const citationsEnabled = withCitations === true;
  const lessonLines = lessonLineMap ?? {};
  const patternLines = patternLineMap ?? {};

  const units: PackUnit[] = [];

  if (routers?.root?.content !== undefined) {
    const routerCitations = citationsEnabled
      ? buildLineCitation({
          path: routers.root.path ?? "AGENTS.md",
          lineStart: 1,
          lineEnd: countLines(routers.root.content),
          label: "root router",
        })
      : undefined;
    units.push({
      id: "router-root",
      label: "root router",
      groupId: "routers",
      groupTitle: "Routers",
      groupOrder: 1,
      order: 1,
      content: formatRouter(
        `Root router (${routers.root.path ?? "AGENTS.md"})`,
        routers.root.content,
      ),
      canDrop: false,
      utility: 0,
      ...(routerCitations ? { citations: routerCitations } : {}),
    });
  }

  if (routers?.scoped) {
    const scopedCitations = citationsEnabled
      ? buildLineCitation({
          path: routers.scoped.path,
          lineStart: 1,
          lineEnd: countLines(routers.scoped.content),
          label: "scoped router",
        })
      : undefined;
    units.push({
      id: "router-scoped",
      label: "scoped router",
      groupId: "routers",
      groupTitle: "Routers",
      groupOrder: 1,
      order: 2,
      content: formatRouter(
        `Scoped router (${routers.scoped.path})`,
        routers.scoped.content,
      ),
      canDrop: false,
      utility: 0,
      ...(scopedCitations ? { citations: scopedCitations } : {}),
    });
  }

  if (queueItem) {
    const queueCitations = citationsEnabled
      ? buildLineCitation({
          path: queuePath ?? null,
          lineStart: queueLine ?? null,
          label: queueItem.id,
        })
      : undefined;
    units.push({
      id: "queue-item",
      label: "queue item",
      groupId: "queue",
      groupTitle: "Queue Item",
      groupOrder: 2,
      order: 1,
      content: formatQueueItem(queueItem),
      canDrop: false,
      utility: 0,
      ...(queueCitations ? { citations: queueCitations } : {}),
    });
  }

  if (contractSections?.length) {
    const contractCitations = citationsEnabled
      ? contractSections
          .map((section) => ({
            path: section.docPath,
            lineStart: section.entry.lineStart,
            lineEnd: section.entry.lineEnd,
            label: section.entry.heading,
          }))
          .filter((citation) => citation.path)
      : [];
    units.push({
      id: "contract-sections",
      label: "contract sections",
      groupId: "contracts",
      groupTitle: "Contract Sections",
      groupOrder: 3,
      order: 1,
      content: formatContractSections(contractSections),
      canDrop: false,
      utility: 0,
      ...(contractCitations.length ? { citations: contractCitations } : {}),
    });
  }

  const keywords = queueItem
    ? [
        queueItem.spec?.problem,
        queueItem.spec?.outcome,
        queueItem.spec?.plan?.rationale,
        ...(queueItem.spec?.plan?.steps ?? []),
      ].flatMap((value) => tokenizeKeywords(value))
    : [];
  const { lessonIds, patternIds } = collectRecentRefs(
    runEntries,
    queueItem?.id ?? null,
  );

  const MAX_LESSONS = 6;
  const rankedLessons = lessons
    .map((lesson) => {
      const matchScore = scoreMatches(keywords, lesson.pattern);
      const referenced = lessonIds.has(lesson.id) ? 3 : 0;
      const utility = matchScore + referenced;
      const lastSeen = Date.parse(lesson.last_seen ?? "");
      return { lesson, utility, lastSeen };
    })
    .filter((entry) => entry.utility > 0)
    .sort((a, b) => {
      if (a.utility !== b.utility) return b.utility - a.utility;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    })
    .slice(0, MAX_LESSONS);

  rankedLessons.forEach((entry, index) => {
    const lessonCitations = citationsEnabled
      ? buildLineCitation({
          path: lessonSourcePath ?? null,
          lineStart: lessonLines[entry.lesson.id] ?? null,
          label: entry.lesson.id,
        })
      : undefined;
    units.push({
      id: `lesson-${entry.lesson.id}`,
      label: `lesson ${entry.lesson.id}`,
      groupId: "lessons",
      groupTitle: "Lessons",
      groupOrder: 4,
      order: index + 1,
      content: formatLessonItem(entry.lesson),
      canDrop: true,
      utility: entry.utility,
      ...(lessonCitations ? { citations: lessonCitations } : {}),
    });
  });

  const MAX_PATTERNS = 6;
  const rankedPatterns = patterns
    .map((pattern) => {
      const matchScore = scoreMatches(keywords, pattern.title);
      const referenced = patternIds.has(pattern.id) ? 3 : 0;
      const utility = matchScore + referenced;
      const lastSeen = Date.parse(pattern.last_seen ?? "");
      return { pattern, utility, lastSeen };
    })
    .filter((entry) => entry.utility > 0)
    .sort((a, b) => {
      if (a.utility !== b.utility) return b.utility - a.utility;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    })
    .slice(0, MAX_PATTERNS);

  rankedPatterns.forEach((entry, index) => {
    const patternCitations = citationsEnabled
      ? buildLineCitation({
          path: patternSourcePath ?? null,
          lineStart: patternLines[entry.pattern.id] ?? null,
          label: entry.pattern.id,
        })
      : undefined;
    units.push({
      id: `pattern-${entry.pattern.id}`,
      label: `pattern ${entry.pattern.id}`,
      groupId: "patterns",
      groupTitle: "Patterns",
      groupOrder: 5,
      order: index + 1,
      content: formatPatternItem(entry.pattern),
      canDrop: true,
      utility: entry.utility,
      ...(patternCitations ? { citations: patternCitations } : {}),
    });
  });

  const MAX_SIGNALS = 5;
  const signals = (blackboardSignals ?? [])
    .slice()
    .sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")))
    .slice(0, MAX_SIGNALS);

  signals.forEach((signal, index) => {
    units.push({
      id: `signal-${index}-${signal.ts ?? "unknown"}`,
      label: `signal ${signal.ts ?? index}`,
      groupId: "signals",
      groupTitle: "Blackboard Signals",
      groupOrder: 6,
      order: index + 1,
      content: formatSignals(signal),
      canDrop: true,
      utility: MAX_SIGNALS - index,
    });
  });

  const nextActions = buildNextActions(queueItem, runEntries);
  if (nextActions.length) {
    units.push({
      id: "next-actions",
      label: "next actions",
      groupId: "next-actions",
      groupTitle: "Next Actions",
      groupOrder: 7,
      order: 1,
      content: formatNextActions(nextActions),
      canDrop: false,
      utility: 0,
    });
  }

  return applyTokenBudget({ format, budget, meta, units, withCitations });
};
