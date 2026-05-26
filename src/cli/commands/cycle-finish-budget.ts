export type FinishProgressPayload = {
  schema_version: "cycle-finish-progress.v1";
  cycle_id: string;
  step: string;
  elapsed_ms: number;
  budget_ms: number;
  updated_at: string;
};

export const buildFinishProgressPayload = ({
  cycleId,
  step,
  elapsedMs,
  budgetMs,
  now,
}: {
  cycleId: string;
  step: string;
  elapsedMs: number;
  budgetMs: number;
  now?: number | string | Date;
}): FinishProgressPayload => ({
  schema_version: "cycle-finish-progress.v1",
  cycle_id: cycleId,
  step,
  elapsed_ms: elapsedMs,
  budget_ms: budgetMs,
  updated_at: new Date(now ?? Date.now()).toISOString(),
});

export const buildBudgetExhaustedPayload = ({
  cycleId,
  step,
  elapsedMs,
  budgetMs,
  progressPath,
}: {
  cycleId: string;
  step: string;
  elapsedMs: number;
  budgetMs: number;
  progressPath: string;
}): {
  ok: false;
  code: "BUDGET_EXHAUSTED";
  error: {
    message: string;
    details: {
      cycle_id: string;
      step: string;
      elapsed_ms: number;
      budget_ms: number;
      progress_path: string;
      suggested_commands: string[];
    };
  };
} => ({
  ok: false,
  code: "BUDGET_EXHAUSTED",
  error: {
    message: "Cycle finish budget exhausted.",
    details: {
      cycle_id: cycleId,
      step,
      elapsed_ms: elapsedMs,
      budget_ms: budgetMs,
      progress_path: progressPath,
      suggested_commands: [
        `ato cycle finish --json --budget-ms ${budgetMs}`,
        `ato cycle finish --json --budget-ms ${budgetMs * 2}`,
      ],
    },
  },
});
