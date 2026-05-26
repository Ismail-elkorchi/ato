export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type ContractRefObject = {
  doc: string;
  section: string;
};

export type ContractRef = string | ContractRefObject;

export type TargetSelector = "exact" | "range" | "milestone" | "unbounded";

export type QueueStatus = "queued" | "active" | "blocked" | "done" | "dropped";

export type QueueType =
  | "bug"
  | "debt"
  | "waiver"
  | "quality-debt"
  | "feature"
  | "doc"
  | "contract"
  | "tooling"
  | "investigation";

export type QueuePriority = "P0" | "P1" | "P2" | "P3" | "P4" | number;

export type QueueNeedStatus = "open" | "resolved";
export type QueueNeedKind = "input" | "decision" | "review" | "resource";

export type QueueTarget = {
  selector?: TargetSelector;
  kind?: TargetSelector;
  value?: string;
};

export type QueueNeed = {
  kind: QueueNeedKind;
  ask: string;
  status: QueueNeedStatus;
  evidence?: string;
};

export type QueueContractScan = {
  inputs?: string[];
  findings?: string[];
  evidence?: string[];
};

export type QueueContractReflection = {
  delta_scan?: QueueContractScan;
  system_scan?: QueueContractScan;
  queue_items?: string[];
  no_actionable_deltas?: boolean;
};

export type QueuePlan = {
  steps: string[];
  rationale?: string;
};

export type QueueDetails = {
  rationale?: string;
  scope?: string[];
  acceptance?: string[];
  acceptance_criteria?: string[];
  risks?: string[];
  inputs?: string[];
  deliverables?: string[];
  scope_paths?: string[];
  contract_refs?: ContractRef[];
  runbook?: string[];
  effort?: "S" | "M" | "L";
  dependencies?: string[];
  blockers?: string[];
  contract_reflection?: QueueContractReflection;
  needs?: QueueNeed[];
  lessons?: string[];
  decision?: string[];
  tradeoffs?: string[];
  invariants?: string[];
  links?: string[];
  contract_review?: string[];
  contract_gaps?: string[];
  contract_followups?: string[];
  competitive_edge?: { claim: string; evidence?: string }[];
};

export type QueueSpec = {
  problem: string;
  outcome: string;
  plan: QueuePlan;
  acceptance_criteria: string[];
  inputs: string[];
  deliverables: string[];
  scope: string[];
  scope_paths?: string[];
  risks: string[];
  contract_refs: ContractRef[];
  runbook: string[];
};

export type QueueFrozen = {
  core_hash?: string;
};

export type QueueOrigin = {
  repo_path?: string;
  repo_remote?: string;
  commit: string;
  subpath?: string;
  created_by?: string;
  contract_refs?: ContractRef[];
};

export type QueueItem = {
  id: string;
  title: string;
  type: QueueType;
  status: QueueStatus;
  priority: QueuePriority;
  tags: string[];
  created_at: string;
  updated_at: string;
  completed_at?: string;
  target: QueueTarget;
  deps: string[];
  evidence: string[];
  owner?: string;
  notes: string;
  spec: QueueSpec;
  details?: QueueDetails;
  origin?: QueueOrigin;
  frozen?: QueueFrozen;
};

export type JsonlRecord<T = JsonValue> = {
  line: number;
  raw: string;
  item: T;
};

export type CycleOutcome = "ok" | "fail" | "inconclusive" | "unknown";

export type CycleSelectionEvidence = {
  mode: "queue";
  cycle_id: string;
  cycle_index: number;
  scope: "block" | "global";
  seed: {
    source: string;
    value: string;
    block_id?: string | null;
  };
  rationale?: {
    seed: string;
    pool_ids: string[];
    chosen_id: string;
    rule: string;
    hash: string;
  } | null;
  excluded_by_reason: {
    out_of_scope: number;
    status: number;
    deps: number;
    missing_evidence: number;
  };
  selection: { queue_id: string; hash: string } | null;
  candidates: { total: number; eligible: number };
};

export type CycleGateArtifactEvidence = {
  path: string;
  sha256: string;
};

export type CycleGateEvidence = {
  mode: "full";
  result?: { ok: boolean };
  artifacts?: CycleGateArtifactEvidence[];
  obligations_hash?: string;
  run_ref?: { path: string; line: number };
};

export type CyclePreflightEvidence = {
  path: string;
  sha256: string;
};

export type CycleCheckRecord = {
  id: string;
  command: string;
  kind?: string;
  status?: "ok" | "fail" | "skipped" | "unknown";
  exitCode?: number;
  durationMs?: number;
  artifacts?: string[];
};

export type CycleRecord = {
  schema_version: "cycle-record.v1";
  id: string;
  ts: string;
  queue_id?: string;
  block_id?: string;
  cycle_index: number;
  hypothesis: string;
  acceptance_checks: string[];
  evidence: string[];
  outcome: CycleOutcome;
  selection_evidence: CycleSelectionEvidence;
  gate_evidence: CycleGateEvidence;
  preflight_evidence: CyclePreflightEvidence;
  pack_ref?: CyclePackRef;
  pack_verify_ref?: PackVerifyRef;
  checks: CycleCheckRecord[];
};

export type LessonItem = {
  id: string;
  tool?: string;
  rule?: string;
  pattern: string;
  prevention: string;
  frequency: number;
  last_seen: string;
  queue_refs?: string[];
  notes?: string;
};

export type PatternItem = {
  id: string;
  title: string;
  kind: string;
  summary?: string;
  steps?: string[];
  signals?: string[];
  queue_refs?: string[];
  frequency: number;
  last_seen: string;
};

export type RunLogCommand = {
  cmd: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
};

export type SignalDefinitionType =
  | "reliability"
  | "cost"
  | "performance"
  | "ux_friction"
  | "docs_drift"
  | "knowledge_quality"
  | "memory_growth"
  | "security"
  | "agent_telemetry";

export type SignalDefinition = {
  name: string;
  type: SignalDefinitionType;
  source: string;
  collection_method: string;
  evidence_format: string;
  action_rule: string;
};

export type SignalDefinitionCatalog = SignalDefinition[];

export type CyclePackRef = {
  kind: "cycle_pack";
  cycle_id: string;
  path: string;
  sha256: string;
  manifest_path: string;
};

export type PackVerifyRef = {
  kind: "pack_verify";
  cycle_id: string;
  path: string;
  sha256: string;
  ok: boolean;
};

export type RunLogEntry = {
  ts: string;
  kind:
    | "gate_run"
    | "cycle_abort"
    | "queue_transition"
    | "queue_update"
    | "lesson_add"
    | "pattern_add"
    | "pattern_apply"
    | "reflect"
    | "pack"
    | "lint"
    | "trace"
    | "dev_run"
    | "cycle_record";
  target_id: string;
  queue_id?: string;
  queue_ids?: string[];
  lesson_ids?: string[];
  pattern_ids?: string[];
  mode?: string;
  commands?: RunLogCommand[];
  artifacts?: string[];
  summary?: string;
};

export type BlackboardSignal = {
  ts: string;
  kind?: string;
  summary: string;
  evidence?: string[];
};

export type BlackboardPost = {
  schema_version: "bb-post.v1";
  id: string;
  created_at: string;
  kind: "note" | "question" | "decision" | "warning";
  author: string;
  scope: {
    block_id: string;
    cycle_id?: string | null;
    queue_id?: string | null;
  };
  text: string;
  payload?: JsonValue;
  trust: "untrusted";
  origin?: {
    repo_id?: string | null;
    repo_fingerprint?: string | null;
  };
};

export type ContractsConfig =
  | string
  | string[]
  | {
      platform?: string;
      extra?: string[];
      requiredDocs?: string[];
    };

export type GateCommandConfig = {
  id: string;
  cmd?: string[];
  command?: string[];
  cwd?: string;
};

export type GateTestsConfig = {
  scopes?: Record<string, GateCommandConfig[]>;
  order?: string[];
  root?: GateCommandConfig[];
};

export type GateOverridesConfig = {
  scopeMap?: Array<{ prefix: string; scope: string }>;
  fast?: GateCommandConfig[];
  full?: {
    tests?: GateTestsConfig;
  };
};

export type GatesConfig = {
  scopeMap?: Array<{ prefix: string; scope: string }>;
  fast?: GateCommandConfig[];
  full?: {
    tests?: GateTestsConfig;
  };
  overrides?: {
    targets?: Record<string, GateOverridesConfig>;
  };
};

export type AtoConfig = {
  version?: number;
  targetId?: string;
  defaultTargetId?: string;
  storeDir?: string;
  fingerprintSeed?: string;
  fingerprint?: string;
  contracts?: ContractsConfig;
  lock?: { ttlMs?: number };
  blackboard?: {
    observations?: Array<{ id?: string; signal?: string; cmd: string[]; cwd?: string }>;
  };
  gates?: GatesConfig;
  pack?: {
    defaultBudget?: number;
  };
  terminology?: {
    aliases?: Record<string, string[]>;
    required?: string[];
  };
};

export type TargetRegistryEntry = {
  id: string;
  root: string;
  fingerprint?: string;
  storeDir?: string;
};

export type TargetRegistry = {
  version?: number;
  targets?: TargetRegistryEntry[];
};

export type TargetContext = {
  id: string;
  root: string;
  storeDir: string;
  storePath: string;
  configPath: string;
  fingerprint: string;
  config: AtoConfig;
  registry: TargetRegistry | null;
};

export type ResolveTargetResult = {
  target: TargetContext;
  explicit: boolean;
};
