// @ts-nocheck
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import {
  parseFlags,
  writeJson,
  writeLines,
  formatTargetLine,
} from "../utils.js";
import { parseJsonInput } from "./input.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  readQueueItems,
  writeQueueItems,
  nextQueueId,
  normalizeQueueTargets,
} from "../../core/queue/store.js";
import { validateQueueItems } from "../../core/queue/validate.js";
import {
  ALLOWED_TYPES,
  ALLOWED_PRIORITIES,
  normalizeTags,
  normalizeEvidence,
  normalizeDeps,
  parseTargetInput,
  ensureTargetValue,
} from "../../core/queue/transitions.js";
import { appendRunLog, getArtifactsDir } from "../../core/runlog.js";
import { readState, writeState } from "../../core/state.js";
import {
  readLessonItems,
  writeLessonItems,
  nextLessonId,
  normalizeLessonInput,
  validateLessonItem,
} from "../../core/learning/lessons.js";
import {
  readPatternItems,
  writePatternItems,
  nextPatternId,
  normalizePatternInput,
  validatePatternItem,
} from "../../core/learning/patterns.js";

const ensureStringArray = (
  value,
  label,
  { min = 1, allowEmpty = false } = {},
) => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return { ok: false, error: `${label} must be an array of strings.` };
  }
  const normalized = value.map((entry) => entry.trim()).filter(Boolean);
  if (!allowEmpty && normalized.length < min) {
    return {
      ok: false,
      error: `${label} must include at least ${min} item(s).`,
    };
  }
  return { ok: true, value: normalized };
};

const normalizeScan = (scan, label) => {
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) {
    return { ok: false, error: `${label} must be an object.` };
  }
  const inputs = ensureStringArray(scan.inputs, `${label}.inputs`);
  if (!inputs.ok) return inputs;
  const findings = ensureStringArray(scan.findings, `${label}.findings`);
  if (!findings.ok) return findings;
  const evidence = ensureStringArray(scan.evidence, `${label}.evidence`);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    value: {
      inputs: inputs.value,
      findings: findings.value,
      evidence: evidence.value,
    },
  };
};

const loadQueueSchema = async () => {
  const schemaUrl = new URL(
    "../../core/schemas/queue.v2.json",
    import.meta.url,
  );
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

const ensureQueueValid = ({ errors, contractError }) => {
  if (!errors.length) return;
  const error = new Error("Queue validation failed.");
  error.code = contractError ? 6 : 3;
  error.details = { errors };
  throw error;
};

const ensureNonEmptyString = (value, label) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return { ok: false, error: `${label} must be a non-empty string.` };
  }
  return { ok: true, value: normalized };
};

const ensureContractRefs = (value, label) => {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${label} must be an array.` };
  }
  const normalized = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) normalized.push(trimmed);
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const doc = String(entry.doc ?? "").trim();
      const section = String(entry.section ?? "").trim();
      if (!doc || !section) {
        return {
          ok: false,
          error: `${label} entries must include doc/section.`,
        };
      }
      normalized.push({ doc, section });
      continue;
    }
    return {
      ok: false,
      error: `${label} entries must be string or {doc, section}.`,
    };
  }
  return { ok: true, value: normalized };
};

const buildReflectItem = ({ entry, items, existingIds }) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, error: "queue_items entries must be objects." };
  }

  const title = String(entry.title ?? "").trim();
  if (!title) return { ok: false, error: "queue_items entry missing title." };

  const type = String(entry.type ?? "debt").trim();
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, error: `Invalid queue_items type '${type}'.` };
  }

  const priority = String(entry.priority ?? "").trim();
  if (!ALLOWED_PRIORITIES.has(priority)) {
    return { ok: false, error: `Invalid queue_items priority '${priority}'.` };
  }

  const effort = String(entry.effort ?? "").trim();
  if (effort && !["S", "M", "L"].includes(effort)) {
    return { ok: false, error: `Invalid queue_items effort '${effort}'.` };
  }

  const specInput = entry.spec;
  if (!specInput || typeof specInput !== "object" || Array.isArray(specInput)) {
    return { ok: false, error: "queue_items entry missing spec." };
  }

  const problem = ensureNonEmptyString(
    specInput.problem,
    "queue_items.spec.problem",
  );
  if (!problem.ok) return { ok: false, error: problem.error };

  const outcome = ensureNonEmptyString(
    specInput.outcome,
    "queue_items.spec.outcome",
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };

  const planSource = specInput.plan;
  if (!planSource || typeof planSource !== "object" || Array.isArray(planSource)) {
    return { ok: false, error: "queue_items.spec.plan must be an object." };
  }
  const planSteps = ensureStringArray(
    planSource.steps,
    "queue_items.spec.plan.steps",
  );
  if (!planSteps.ok) return { ok: false, error: planSteps.error };
  const planRationale = planSource.rationale
    ? ensureNonEmptyString(
        planSource.rationale,
        "queue_items.spec.plan.rationale",
      )
    : { ok: true, value: undefined };
  if (!planRationale.ok) return { ok: false, error: planRationale.error };

  const acceptanceCriteria = ensureStringArray(
    specInput.acceptance_criteria,
    "queue_items.spec.acceptance_criteria",
  );
  if (!acceptanceCriteria.ok)
    return { ok: false, error: acceptanceCriteria.error };

  const inputs = ensureStringArray(specInput.inputs, "queue_items.spec.inputs");
  if (!inputs.ok) return { ok: false, error: inputs.error };

  const deliverables = ensureStringArray(
    specInput.deliverables,
    "queue_items.spec.deliverables",
  );
  if (!deliverables.ok) return { ok: false, error: deliverables.error };

  const scope = ensureStringArray(
    specInput.scope ?? [],
    "queue_items.spec.scope",
    {
      min: 0,
      allowEmpty: true,
    },
  );
  if (!scope.ok) return { ok: false, error: scope.error };

  const risks = ensureStringArray(
    specInput.risks ?? [],
    "queue_items.spec.risks",
    {
      min: 0,
      allowEmpty: true,
    },
  );
  if (!risks.ok) return { ok: false, error: risks.error };

  const runbook = ensureStringArray(
    specInput.runbook ?? [],
    "queue_items.spec.runbook",
    { min: 0, allowEmpty: true },
  );
  if (!runbook.ok) return { ok: false, error: runbook.error };

  const scopePaths = specInput.scope_paths
    ? ensureStringArray(specInput.scope_paths, "queue_items.spec.scope_paths", {
        min: 0,
        allowEmpty: true,
      })
    : { ok: true, value: [] };
  if (!scopePaths.ok) return { ok: false, error: scopePaths.error };

  const contractRefs = ensureContractRefs(
    specInput.contract_refs ?? [],
    "queue_items.spec.contract_refs",
  );
  if (!contractRefs.ok) return { ok: false, error: contractRefs.error };

  const rationale = String(entry.rationale ?? "").trim();

  const idInput = String(entry.id ?? "").trim();
  const id = !idInput || idInput === "TBD" ? nextQueueId(items) : idInput;
  if (!/^BL-\d{4,}$/.test(id)) {
    return { ok: false, error: `Invalid queue_items id '${id}'.` };
  }
  if (existingIds.has(id)) {
    return { ok: false, error: `queue_items id '${id}' already exists.` };
  }

  const target = entry.target ? entry.target : null;
  let normalizedTarget = target ? target : null;
  if (typeof target === "string") {
    normalizedTarget = parseTargetInput(target);
  }
  if (normalizedTarget && !ensureTargetValue(normalizedTarget)) {
    return { ok: false, error: "Target value missing for queue_items entry." };
  }

  const dependencies = Array.isArray(entry.dependencies)
    ? entry.dependencies
    : [];
  const blockers = Array.isArray(entry.blockers) ? entry.blockers : [];

  const tags = normalizeTags(Array.isArray(entry.tags) ? entry.tags : []);
  const evidence = normalizeEvidence(
    Array.isArray(entry.evidence) ? entry.evidence : [],
  );

  const spec = {
    problem: problem.value,
    outcome: outcome.value,
    plan: {
      steps: planSteps.value,
      ...(planRationale.value ? { rationale: planRationale.value } : {}),
    },
    acceptance_criteria: acceptanceCriteria.value,
    inputs: inputs.value,
    deliverables: deliverables.value,
    scope: scope.value,
    risks: risks.value,
    contract_refs: contractRefs.value,
    runbook: runbook.value,
    ...(scopePaths.value.length ? { scope_paths: scopePaths.value } : {}),
  };

  const details = {
    ...(rationale ? { rationale } : {}),
    ...(effort ? { effort } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(blockers.length ? { blockers } : {}),
    ...(Array.isArray(entry.links) ? { links: entry.links } : {}),
  };

  const item = normalizeQueueTargets({
    id,
    title,
    type,
    status: "queued",
    priority,
    tags,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target: normalizedTarget ?? parseTargetInput("unbounded"),
    deps: normalizeDeps(dependencies),
    evidence,
    owner: entry.owner ?? "agent",
    notes: entry.notes ? String(entry.notes) : "",
    spec,
    details,
  });

  return { ok: true, id, item };
};

export const runReflectCommand = async ({ subcommand, args, context }) => {
  const json = context.json;

  if (subcommand === "record") {
    const { flags } = parseFlags(args);
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

    try {
      const id = flags.id;
      if (!id) throw new Error("Missing required --id.");

      const input = await parseJsonInput(flags.input);
      if (!input.ok) throw new Error(input.error);

      const payload = input.value;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Reflection payload must be a JSON object.");
      }

      const delta = normalizeScan(payload.delta_scan, "delta_scan");
      if (!delta.ok) throw new Error(delta.error);

      const system = normalizeScan(payload.system_scan, "system_scan");
      if (!system.ok) throw new Error(system.error);

      const rawQueueItems = Array.isArray(payload.queue_items)
        ? payload.queue_items
        : [];
      const noActionable = payload.no_actionable_deltas === true;
      const lessonsToAdd = Array.isArray(payload.lessons_to_add)
        ? payload.lessons_to_add
        : [];
      const patternsToAdd = Array.isArray(payload.patterns_to_add)
        ? payload.patterns_to_add
        : [];

      if (!rawQueueItems.length && !noActionable) {
        throw new Error(
          "Reflection requires queue_items or no_actionable_deltas=true.",
        );
      }
      if (rawQueueItems.length && noActionable) {
        throw new Error(
          "Reflection cannot set no_actionable_deltas with queue_items.",
        );
      }

      const records = await readQueueItems(target.storePath);
      const items = records.map((record) => record.item);
      const schema = await loadQueueSchema();
      const preValidation = await validateQueueItems({
        items,
        schema,
        config: target.config,
        root: target.root,
        store: target.storePath,
      });
      ensureQueueValid(preValidation);
      const existingIds = new Set(items.map((item) => item.id));
      const createdIds = [];

      for (const entry of rawQueueItems) {
        const built = buildReflectItem({ entry, items, existingIds });
        if (!built.ok) throw new Error(built.error);
        items.push(built.item);
        createdIds.push(built.id);
        existingIds.add(built.id);
      }

      for (const entryId of createdIds) {
        const item = items.find((item) => item.id === entryId);
        if (!item) continue;
        for (const dep of item.deps ?? []) {
          if (!existingIds.has(dep)) {
            throw new Error(`queue_items dependency '${dep}' does not exist.`);
          }
        }
      }

      const index = items.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`Unknown ID: ${id}`);

      const reflection = {
        delta_scan: delta.value,
        system_scan: system.value,
        queue_items: createdIds,
        ...(noActionable ? { no_actionable_deltas: true } : {}),
      };

      const item = items[index];
      const details = {
        ...(item.details ?? {}),
        contract_reflection: reflection,
      };
      items[index] = { ...item, details, updated_at: new Date().toISOString() };

      const addedLessonIds = [];
      if (lessonsToAdd.length) {
        const lessons = await readLessonItems(target.storePath);
        const lessonIds = new Set(lessons.map((lesson) => lesson.id));
        for (const entry of lessonsToAdd) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("lessons_to_add entries must be objects.");
          }
          const nextId = entry.id
            ? String(entry.id).trim()
            : nextLessonId(lessons);
          if (lessonIds.has(nextId)) {
            throw new Error(`lesson id '${nextId}' already exists.`);
          }
          const lesson = normalizeLessonInput({
            input: { ...entry, id: nextId },
            fallbackId: nextId,
            now: new Date().toISOString(),
          });
          const lessonValidation = await validateLessonItem(lesson);
          if (!lessonValidation.ok) {
            throw new Error(
              `Invalid lesson '${nextId}': ${lessonValidation.errors.join(", ")}`,
            );
          }
          lessons.push(lesson);
          lessonIds.add(lesson.id);
          addedLessonIds.push(lesson.id);
        }
        if (addedLessonIds.length) {
          await writeLessonItems(target.storePath, lessons);
        }
      }

      const addedPatternIds = [];
      if (patternsToAdd.length) {
        const patterns = await readPatternItems(target.storePath);
        const patternIds = new Set(patterns.map((pattern) => pattern.id));
        for (const entry of patternsToAdd) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("patterns_to_add entries must be objects.");
          }
          const nextId = entry.id
            ? String(entry.id).trim()
            : nextPatternId(patterns);
          if (patternIds.has(nextId)) {
            throw new Error(`pattern id '${nextId}' already exists.`);
          }
          const pattern = normalizePatternInput({
            input: { ...entry, id: nextId },
            fallbackId: nextId,
            now: new Date().toISOString(),
          });
          const patternValidation = await validatePatternItem(pattern);
          if (!patternValidation.ok) {
            throw new Error(
              `Invalid pattern '${nextId}': ${patternValidation.errors.join(", ")}`,
            );
          }
          patterns.push(pattern);
          patternIds.add(pattern.id);
          addedPatternIds.push(pattern.id);
        }
        if (addedPatternIds.length) {
          await writePatternItems(target.storePath, patterns);
        }
      }

      const postValidation = await validateQueueItems({
        items,
        schema,
        config: target.config,
        root: target.root,
        store: target.storePath,
      });
      ensureQueueValid(postValidation);

      await writeQueueItems(target.storePath, items);

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "reflect",
        target_id: target.id,
        queue_id: id,
        ...(addedLessonIds.length ? { lesson_ids: addedLessonIds } : {}),
        ...(addedPatternIds.length ? { pattern_ids: addedPatternIds } : {}),
        commands: [],
        artifacts: [],
        summary: `reflect record ${id}`,
      });

      const state = await readState(target.storePath);
      const nextState = {
        ...state,
        version: state.version ?? 1,
        targetId: target.id,
        lastReflect: {
          queueId: id,
          ts: new Date().toISOString(),
        },
      };
      await writeState(target.storePath, nextState);

      const payloadOut = {
        ok: true,
        id,
        queue_items: createdIds,
        lessons_added: addedLessonIds,
        patterns_added: addedPatternIds,
      };
      if (json) {
        writeJson(payloadOut);
      } else {
        writeLines([
          formatTargetLine(target),
          `reflect: ${id}`,
          `created: ${createdIds.join(", ") || "none"}`,
          `lessons: ${addedLessonIds.join(", ") || "none"}`,
          `patterns: ${addedPatternIds.join(", ") || "none"}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (subcommand === "run") {
    const { flags } = parseFlags(args);
    const target = await resolveTargetContext({ context, requireWrite: true });
    await ensureProtocol(target.root);
    const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);

    try {
      const id = flags.id;
      if (!id) throw new Error("Missing required --id.");

      const commands = [];
      const artifacts = [];
      const artifactDir = getArtifactsDir(target.storePath, id, "reflect");
      await fs.mkdir(artifactDir, { recursive: true });

      const runShell = async (label, commandLine) => {
        if (!commandLine) return;
        const start = Date.now();
        const result = await new Promise((resolve) => {
          const child = spawn(commandLine, { cwd: target.root, shell: true });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          child.on("close", (code) => {
            resolve({
              exitCode: code ?? 1,
              durationMs: Date.now() - start,
              stdout,
              stderr,
            });
          });
        });
        const artifactPath = path.join(
          artifactDir,
          `${label}-${Date.now()}.log`,
        );
        await fs.writeFile(
          artifactPath,
          `${result.stdout}\n${result.stderr}`,
          "utf8",
        );
        artifacts.push(artifactPath);
        commands.push({
          cmd: commandLine,
          cwd: target.root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
      };

      await runShell("delta", flags.delta);
      await runShell("system", flags.system);

      await appendRunLog(target.storePath, {
        ts: new Date().toISOString(),
        kind: "reflect",
        target_id: target.id,
        queue_id: id,
        commands,
        artifacts,
        summary: `reflect run ${id}`,
      });

      if (json) {
        writeJson({ ok: true, id, artifacts, commands });
      } else {
        writeLines([
          formatTargetLine(target),
          `reflect run: ${id}`,
          `commands: ${commands.length}`,
        ]);
      }
    } finally {
      await releaseWriteLock(lockPath);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown reflect subcommand." },
    });
  } else {
    writeLines([
      "Unknown reflect subcommand.",
      "Usage: ato reflect record|run",
    ]);
  }
  process.exitCode = 1;
};
