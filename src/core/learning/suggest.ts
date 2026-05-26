import type { LessonItem, PatternItem } from "../types.js";

const tokenize = (value: string | null): string[] => {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
};

const scoreMatch = (haystack: string, tokens: string[]): number => {
  if (!tokens.length) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += 1;
  }
  return score;
};

export const suggestLessons = ({
  lessons,
  query,
  limit = 3,
}: {
  lessons: LessonItem[];
  query?: string | null;
  limit?: number;
}): LessonItem[] => {
  const tokens = tokenize(query ?? "");
  const scored = lessons.map((lesson) => {
    const content = [
      lesson.tool ?? "",
      lesson.rule ?? "",
      lesson.pattern ?? "",
      lesson.prevention ?? "",
      lesson.notes ?? "",
    ].join(" ");
    return {
      lesson,
      score: scoreMatch(content, tokens),
    };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.lesson.frequency !== b.lesson.frequency) {
      return b.lesson.frequency - a.lesson.frequency;
    }
    return a.lesson.id.localeCompare(b.lesson.id);
  });
  return scored
    .filter((entry) => (tokens.length ? entry.score > 0 : true))
    .slice(0, limit)
    .map((entry) => entry.lesson);
};

export const suggestPatterns = ({
  patterns,
  query,
  limit = 3,
}: {
  patterns: PatternItem[];
  query?: string | null;
  limit?: number;
}): PatternItem[] => {
  const tokens = tokenize(query ?? "");
  const scored = patterns.map((pattern) => {
    const content = [
      pattern.title ?? "",
      pattern.kind ?? "",
      pattern.summary ?? "",
      ...(pattern.steps ?? []),
      ...(pattern.signals ?? []),
    ].join(" ");
    return {
      pattern,
      score: scoreMatch(content, tokens),
    };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.pattern.frequency !== b.pattern.frequency) {
      return b.pattern.frequency - a.pattern.frequency;
    }
    return a.pattern.id.localeCompare(b.pattern.id);
  });
  return scored
    .filter((entry) => (tokens.length ? entry.score > 0 : true))
    .slice(0, limit)
    .map((entry) => entry.pattern);
};
