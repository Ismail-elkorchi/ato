import path from "node:path";

import { appendJsonl } from "../fs.js";

export type SuggestionRecord = {
  ts: string;
  kind: "gate_failure";
  queue_id?: string;
  lesson_id?: string | null;
  query?: string | null;
  failure?: { command?: string; exitCode?: number } | null;
  suggestions: {
    lessons: string[];
    patterns: string[];
  };
};

const suggestionLogPath = (store: string): string =>
  path.join(store, "memory", "learning", "suggestions.jsonl");

export const recordSuggestion = async ({
  store,
  kind,
  queueId,
  lessonId,
  query,
  failure,
  suggestions,
}: {
  store: string;
  kind: SuggestionRecord["kind"];
  queueId?: string;
  lessonId?: string | null;
  query?: string | null;
  failure?: { command?: string; exitCode?: number } | null;
  suggestions: { lessons: string[]; patterns: string[] };
}): Promise<SuggestionRecord> => {
  const record: SuggestionRecord = {
    ts: new Date().toISOString(),
    kind,
    ...(queueId ? { queue_id: queueId } : {}),
    ...(lessonId !== undefined ? { lesson_id: lessonId } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(failure ? { failure } : {}),
    suggestions: {
      lessons: suggestions.lessons ?? [],
      patterns: suggestions.patterns ?? [],
    },
  };
  await appendJsonl(suggestionLogPath(store), record);
  return record;
};
