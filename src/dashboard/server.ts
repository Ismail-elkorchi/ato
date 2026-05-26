// @ts-nocheck
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkProtocolCompatibility,
  readAgentsMetadata,
} from "../core/protocol.js";
import { resolveTarget, TargetError } from "../core/targets/resolve.js";
import { computeFingerprint } from "../core/targets/fingerprint.js";
import { acquireLock, releaseLock, getLockPath } from "../core/lock.js";
import {
  readQueueItems,
  writeQueueItems,
  nextQueueId,
  normalizeQueueTargets,
} from "../core/queue/store.js";
import { selectNextItems } from "../core/queue/ordering.js";
import {
  ALLOWED_TYPES,
  ALLOWED_PRIORITIES,
  STATUS_TRANSITIONS,
  normalizeTags,
  normalizeEvidence,
  normalizeDeps,
  parseTargetInput,
  ensureTargetValue,
  computeCoreHash,
} from "../core/queue/transitions.js";
import { readState, writeState } from "../core/state.js";
import { readBlackboardPosts } from "../core/blackboard.js";
import { buildBlackboardView } from "../core/blackboard/view.js";
import {
  readLessonItems,
  writeLessonItems,
  nextLessonId,
  normalizeLessonInput,
  validateLessonItem,
} from "../core/learning/lessons.js";
import {
  readPatternItems,
  writePatternItems,
  nextPatternId,
  normalizePatternInput,
  validatePatternItem,
} from "../core/learning/patterns.js";
import {
  appendRunLog,
  getArtifactsDir,
  getRunLogPath,
} from "../core/runlog.js";
import { buildPack } from "../core/pack/generator.js";
import { resolveSectionFromIndex, toContractDocKey } from "../core/contracts/index.js";
import { extractSection } from "../core/contracts/extract.js";
import { readJson, readJsonl, ensureDir, fileExists } from "../core/fs.js";
import { runGates } from "../core/gates/runner.js";
import { writeQueueViews, validateQueueItems } from "./queue-utils.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const atoRoot = path.resolve(moduleDir, "..", "..");
const dashboardSrcDir = moduleDir;
const dashboardDistDir = path.join(atoRoot, "dist", "dashboard");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

const copyDir = async (source, dest) => {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      if (!data) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });

const sendJson = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
};

const sendError = (
  res,
  status,
  message,
  details,
  suggestion,
  type = "request",
) => {
  sendJson(res, status, {
    ok: false,
    error: { type, message, details, suggestion },
  });
};

const loadQueueSchema = async () => {
  const schemaUrl = new URL("../core/schemas/queue.v2.json", import.meta.url);
  const raw = await fs.readFile(schemaUrl, "utf8");
  return JSON.parse(raw);
};

const PATHISH_EXT = /\.[a-z0-9]+$/i;

const isPathLike = (value) => {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    PATHISH_EXT.test(trimmed)
  );
};

const normalizeCandidatePath = (value, root) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) {
    return path.relative(root, normalized).replace(/\\/g, "/");
  }
  return normalized;
};

const toPosixPath = (value) => value.replace(/\\/g, "/");

const deriveCandidatePaths = (queueItem, root) => {
  if (!queueItem?.spec) return [];
  const scopeEntries = Array.isArray(queueItem.spec.scope)
    ? queueItem.spec.scope
    : [];
  const scopePaths = Array.isArray(queueItem.spec.scope_paths)
    ? queueItem.spec.scope_paths
    : [];
  const raw = [
    ...scopeEntries.filter((entry) => isPathLike(entry)),
    ...scopePaths,
  ];
  const result = new Set();
  for (const entry of raw) {
    const normalized = normalizeCandidatePath(entry, root);
    if (normalized) result.add(normalized);
  }
  return [...result];
};

const globToRegExp = (pattern) => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
};

const selectScopedRouter = (routers, candidatePaths) => {
  if (!candidatePaths.length) return null;
  const scoped = routers.filter(
    (router) => router.scope && router.path !== "AGENTS.md",
  );
  let match = null;
  for (const router of scoped) {
    const pattern = globToRegExp(router.scope);
    for (const candidate of candidatePaths) {
      if (pattern.test(candidate)) {
        if (!match || router.scope.length > match.scope.length) {
          match = router;
        }
      }
    }
  }
  return match;
};

const resolveRouters = async ({ target, candidatePaths }) => {
  const indexPath = path.join(target.storePath, "cache", "routes.index.json");
  const index = await readJson(indexPath, null);
  const routers = index?.routers ?? [];
  const rootRouter = routers.find((router) => router.path === "AGENTS.md") ?? {
    path: "AGENTS.md",
  };
  const scopedRouter = selectScopedRouter(routers, candidatePaths);

  const rootPath = path.join(target.root, rootRouter.path ?? "AGENTS.md");
  const rootContent = await fs.readFile(rootPath, "utf8").catch(() => "");

  let scoped = null;
  if (scopedRouter) {
    const scopedContent = await fs
      .readFile(path.join(target.root, scopedRouter.path), "utf8")
      .catch(() => "");
    scoped = {
      path: scopedRouter.path,
      scope: scopedRouter.scope ?? null,
      content: scopedContent,
    };
  }

  return {
    root: {
      path: rootRouter.path ?? "AGENTS.md",
      scope: rootRouter.scope ?? null,
      content: rootContent,
    },
    scoped,
  };
};

const sendFile = async (res, filePath) => {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = await fs.readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
};

const resolveStaticFile = async (
  filePath,
  requestPath,
  rootDir = dashboardDistDir,
) => {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootDir);
  const rootMatch =
    resolved === resolvedRoot ||
    resolved.startsWith(`${resolvedRoot}${path.sep}`);
  if (!rootMatch) return null;
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    const ext = path.extname(resolved);
    if (!ext) {
      const candidates = [".js", ".css", ".json"];
      for (const suffix of candidates) {
        const candidate = `${resolved}${suffix}`;
        if (await fileExists(candidate)) return candidate;
      }
    }
    return null;
  }
  if (stat.isDirectory()) {
    if (requestPath && !requestPath.endsWith("/")) {
      return { redirect: `${requestPath}/` };
    }
    for (const candidate of ["index.html", "index.js"]) {
      const candidatePath = path.join(resolved, candidate);
      if (await fileExists(candidatePath)) return candidatePath;
    }
    return null;
  }
  return resolved;
};

const findNearestConfigRoot = async (startDir) => {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".ato", "config.json");
    if (await fileExists(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const loadConfig = async (rootDir) => {
  const configPath = path.join(rootDir, ".ato", "config.json");
  const config = await readJson(configPath, null);
  if (!config) {
    throw new Error(`Missing .ato/config.json at ${rootDir}`);
  }
  return { configPath, config };
};

const loadRegistry = async (rootDir) => {
  const registryPath = path.join(rootDir, ".ato", "targets.json");
  const registry = await readJson(registryPath, null);
  return registry ? { registryPath, registry } : null;
};

const resolveTargetSafe = async ({ cwd, selection, storeSelection, requireWrite }) => {
  try {
    const result = await resolveTarget({
      cwd,
      selection,
      storeSelection,
      requireWrite,
    });
    return { target: result.target, explicit: result.explicit, error: null };
  } catch (error) {
    if (error instanceof TargetError) {
      return { target: null, explicit: false, error };
    }
    throw error;
  }
};

const getLastGate = async (store) => {
  const records = await readJsonl(getRunLogPath(store));
  const gates = records
    .map((record) => record.item)
    .filter((item) => item.kind === "gate_run");
  if (!gates.length) return null;
  gates.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const latest = gates[0];
  const ok = latest.summary?.includes("ok") ?? null;
  return { mode: latest.mode, ok, ts: latest.ts };
};

const resolveTargetContext = async ({
  req,
  requireWrite,
  defaultSelection,
}) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const selection = url.searchParams.get("target") ?? defaultSelection ?? null;
  const storeSelection =
    url.searchParams.get("store") ?? process.env["ATO_STORE"] ?? null;
  return resolveTargetSafe({
    cwd: process.cwd(),
    selection,
    storeSelection,
    requireWrite,
  });
};

const ensureProtocol = async (root) => {
  const result = await checkProtocolCompatibility(root);
  if (!result.ok) {
    const error = new Error("Protocol version check failed.");
    error.details = result;
    throw error;
  }
  return result;
};

const acquireWriteLock = async (target) => {
  await ensureDir(target.storePath);
  const lock = await acquireLock(target.storePath, target.config.lock?.ttlMs);
  if (!lock.ok) {
    const error = new Error("Target store is locked by another process.");
    error.details = { lockPath: lock.lockPath, lock: lock.current };
    throw error;
  }
  return lock.lockPath;
};

const assertTransition = (item, nextStatus) => {
  const allowed = STATUS_TRANSITIONS.get(item.status) ?? new Set();
  if (!allowed.has(nextStatus)) {
    return `Invalid transition ${item.status} -> ${nextStatus}`;
  }
  return null;
};

export const buildDashboardAssets = async () => {
  const dashboardDir = dashboardDistDir;
  const srcDir = path.resolve(dashboardSrcDir);
  const destDir = path.resolve(dashboardDir);
  if (srcDir !== destDir) {
    await fs.rm(dashboardDir, { recursive: true, force: true });
    await copyDir(dashboardSrcDir, dashboardDir);
  } else {
    await ensureDir(dashboardDir);
  }

  return dashboardDir;
};

const ensureDashboardAssets = async () => {
  const indexPath = path.join(dashboardDistDir, "index.html");
  if (await fileExists(indexPath)) {
    return indexPath;
  }
  await buildDashboardAssets();
  if (!(await fileExists(indexPath))) {
    throw new Error(
      "Dashboard assets missing. Run `ato dashboard build` first.",
    );
  }
  return indexPath;
};

const VENDOR_ROOTS = new Map([
  [
    "ui-tokens",
    path.join(atoRoot, "node_modules", "@ismail-elkorchi", "ui-tokens", "dist"),
  ],
  [
    "ui-primitives",
    path.join(
      atoRoot,
      "node_modules",
      "@ismail-elkorchi",
      "ui-primitives",
      "dist",
    ),
  ],
  [
    "ui-shell",
    path.join(atoRoot, "node_modules", "@ismail-elkorchi", "ui-shell", "dist"),
  ],
  ["lit", path.join(atoRoot, "node_modules", "lit")],
  ["lit-html", path.join(atoRoot, "node_modules", "lit-html")],
  ["lit-element", path.join(atoRoot, "node_modules", "lit-element")],
  [
    "@lit/reactive-element",
    path.join(atoRoot, "node_modules", "@lit", "reactive-element"),
  ],
]);

const resolveVendorFile = (pathname) => {
  if (!pathname.startsWith("/vendor/")) return null;
  const subpath = pathname.slice("/vendor/".length);
  if (!subpath) return null;
  const parts = subpath.split("/").filter(Boolean);
  if (!parts.length) return null;
  let vendorKey;
  let rest;
  if (parts[0]?.startsWith("@")) {
    if (parts.length < 2) return null;
    vendorKey = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    vendorKey = parts[0];
    rest = parts.slice(1);
  }
  const root = VENDOR_ROOTS.get(vendorKey);
  if (!root) return null;
  return { root, filePath: path.join(root, ...rest) };
};

export const startDashboardServer = async ({ port, defaultSelection }) => {
  const indexPath = await ensureDashboardAssets();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname.startsWith("/vendor/")) {
        const vendor = resolveVendorFile(pathname);
        if (!vendor) {
          sendError(res, 404, "Not found.");
          return;
        }
        const resolved = await resolveStaticFile(
          vendor.filePath,
          pathname,
          vendor.root,
        );
        if (!resolved) {
          sendError(res, 404, "Not found.");
          return;
        }
        if (resolved?.redirect) {
          res.writeHead(302, { Location: resolved.redirect });
          res.end();
          return;
        }
        await sendFile(res, resolved);
        return;
      }

      if (pathname.startsWith("/api/")) {
        await handleApiRequest(req, res, { url, defaultSelection });
        return;
      }

      const filePath =
        pathname === "/" ? indexPath : path.join(dashboardDistDir, pathname);
      const resolved = await resolveStaticFile(filePath, pathname);
      if (!resolved) {
        sendError(res, 404, "Not found.");
        return;
      }
      if (resolved?.redirect) {
        res.writeHead(302, { Location: resolved.redirect });
        res.end();
        return;
      }
      await sendFile(res, resolved);
    } catch (error) {
      sendError(res, 500, error.message ?? "Server error.", {
        stack: error.stack,
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({ server, port });
    });
  });
};

const handleApiRequest = async (req, res, { url, defaultSelection }) => {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/api/status" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });

    const root = await findNearestConfigRoot(process.cwd());
    const registryInfo = root ? await loadRegistry(root) : null;
    const available = registryInfo?.registry?.targets ?? [];
    const requireSelection = !targetResult.target && available.length > 1;

    if (!targetResult.target) {
      sendJson(res, 200, {
        ok: true,
        target: null,
        protocol: null,
        lock: null,
        lastGate: null,
        targets: {
          available: available.map((entry) => ({ id: entry.id })),
          requireSelection,
        },
      });
      return;
    }

    const protocol = await checkProtocolCompatibility(targetResult.target.root);
    const lockPath = getLockPath(targetResult.target.storePath);
    const lock = (await readJson(lockPath, null)) ?? null;
    const lastGate = await getLastGate(targetResult.target.storePath);

    sendJson(res, 200, {
      ok: true,
      target: targetResult.target,
      protocol,
      lock: { isLocked: Boolean(lock), lock },
      lastGate,
      targets: {
        available: available.map((entry) => ({ id: entry.id })),
        requireSelection,
      },
    });
    return;
  }

  if (pathname === "/api/queue" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const records = await readQueueItems(targetResult.target.storePath);
    sendJson(res, 200, {
      ok: true,
      items: records.map((record) => record.item),
    });
    return;
  }

  if (pathname === "/api/queue/template" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const records = await readQueueItems(targetResult.target.storePath);
    const id = nextQueueId(records);
    const now = new Date().toISOString();
    const item = {
      id,
      title: "New queue item",
      type: "feature",
      status: "queued",
      priority: "P2",
      tags: [],
      created_at: now,
      updated_at: now,
      target: parseTargetInput("unbounded"),
      deps: [],
      evidence: [],
      owner: "agent",
      notes: "",
      spec: {
        problem: "",
        outcome: "",
        plan: {
          steps: [],
        },
        acceptance_criteria: [],
        inputs: [],
        deliverables: [],
        scope: [],
        risks: [],
        contract_refs: [],
        runbook: [],
      },
    };
    sendJson(res, 200, { ok: true, item });
    return;
  }

  if (pathname === "/api/queue/save" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body?.item) {
      sendError(res, 400, "Missing queue item.");
      return;
    }
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: true,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    const lockPath = await acquireWriteLock(targetResult.target);
    try {
      const records = await readQueueItems(targetResult.target.storePath);
      const items = records.map((record) => record.item);
      const index = items.findIndex((entry) => entry.id === body.item.id);
      const now = new Date().toISOString();
      const updated = {
        ...body.item,
        created_at: body.item.created_at ?? now,
        updated_at: now,
      };
      if (index === -1) {
        items.push(updated);
      } else {
        items[index] = updated;
      }

      const schemaUrl = new URL(
        "../core/schemas/queue.v2.json",
        import.meta.url,
      );
      const schemaRaw = await fs.readFile(schemaUrl, "utf8");
      const schema = JSON.parse(schemaRaw);
      const { errors } = await validateQueueItems({
        items,
        schema,
        config: targetResult.target.config,
        root: targetResult.target.root,
        store: targetResult.target.storePath,
      });
      if (errors.length) {
        sendError(
          res,
          400,
          "Queue validation failed.",
          { errors },
          "Fix validation errors and retry.",
          "validation",
        );
        return;
      }

      await writeQueueItems(targetResult.target.storePath, items);
      await writeQueueViews(targetResult.target.storePath, items);
      await appendRunLog(targetResult.target.storePath, {
        ts: new Date().toISOString(),
        kind: "queue_transition",
        target_id: targetResult.target.id,
        queue_id: body.item.id,
        commands: [],
        artifacts: [],
        summary: "queue save",
      });

      sendJson(res, 200, { ok: true, items });
    } finally {
      await releaseLock(lockPath);
    }
    return;
  }

  if (pathname === "/api/queue/transition" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const action = body?.action;
    const id = body?.id;
    if (!action || !id) {
      sendError(res, 400, "Missing action or id.");
      return;
    }

    const targetResult = await resolveTargetContext({
      req,
      requireWrite: true,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    const lockPath = await acquireWriteLock(targetResult.target);

    try {
      const records = await readQueueItems(targetResult.target.storePath);
      const items = records.map((record) => record.item);
      const index = items.findIndex((entry) => entry.id === id);
      if (index === -1) {
        sendError(res, 404, "Queue id not found.");
        return;
      }

      if (action === "start") {
        const transitionError = assertTransition(items[index], "active");
        if (transitionError) {
          sendError(res, 400, transitionError);
          return;
        }
        items[index] = {
          ...items[index],
          status: "active",
          updated_at: new Date().toISOString(),
        };
        await writeQueueItems(targetResult.target.storePath, items);
        await writeQueueViews(targetResult.target.storePath, items);
        const state = await readState(targetResult.target.storePath);
        await writeState(targetResult.target.storePath, {
          ...state,
          version: state.version ?? 1,
          targetId: targetResult.target.id,
          activeQueueId: id,
        });
        await appendRunLog(targetResult.target.storePath, {
          ts: new Date().toISOString(),
          kind: "queue_transition",
          target_id: targetResult.target.id,
          queue_id: id,
          commands: [],
          artifacts: [],
          summary: "queue start",
        });
        sendJson(res, 200, { ok: true, id, status: "active" });
        return;
      }

      if (action === "block") {
        const transitionError = assertTransition(items[index], "blocked");
        if (transitionError) {
          sendError(res, 400, transitionError);
          return;
        }
        const reason = body.reason ? String(body.reason) : "";
        const details = { ...(items[index].details ?? {}) };
        if (reason) {
          details.blockers = normalizeEvidence([
            ...(details.blockers ?? []),
            reason,
          ]);
        }
        items[index] = {
          ...items[index],
          status: "blocked",
          updated_at: new Date().toISOString(),
          details,
        };
        await writeQueueItems(targetResult.target.storePath, items);
        await writeQueueViews(targetResult.target.storePath, items);
        await appendRunLog(targetResult.target.storePath, {
          ts: new Date().toISOString(),
          kind: "queue_transition",
          target_id: targetResult.target.id,
          queue_id: id,
          commands: [],
          artifacts: [],
          summary: "queue block",
        });
        sendJson(res, 200, { ok: true, id, status: "blocked" });
        return;
      }

      if (action === "done") {
        const transitionError = assertTransition(items[index], "done");
        if (transitionError) {
          sendError(res, 400, transitionError);
          return;
        }
        const tags = items[index].tags ?? [];
        const requiredMode =
          tags.includes("macro-scope") || tags.includes("contract")
            ? "full"
            : "fast";
        const mode = body.mode ?? requiredMode;
        if (!["fast", "full"].includes(mode)) {
          sendError(res, 400, "Invalid gate mode.");
          return;
        }
        const artifactsDir = getArtifactsDir(
          targetResult.target.storePath,
          id,
          "gate",
        );
        const gate = await runGates({
          root: targetResult.target.root,
          targetId: targetResult.target.id,
          queueId: id,
          mode,
          config: targetResult.target.config,
          artifactsDir,
          env: process.env,
        });

        await appendRunLog(targetResult.target.storePath, {
          ts: new Date().toISOString(),
          kind: "gate_run",
          target_id: targetResult.target.id,
          queue_id: id,
          mode: gate.mode,
          commands: gate.results.map((result) => ({
            cmd: result.command,
            cwd: targetResult.target.root,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          })),
          artifacts: gate.artifacts,
          summary: `gate ${gate.ok ? "ok" : "fail"}`,
        });

        const state = await readState(targetResult.target.storePath);
        const nextState = {
          ...state,
          version: state.version ?? 1,
          targetId: targetResult.target.id,
          lastGate: {
            mode,
            ok: gate.ok,
            ts: new Date().toISOString(),
          },
        };
        if (nextState.activeQueueId === id) {
          delete nextState.activeQueueId;
        }
        await writeState(targetResult.target.storePath, nextState);

        if (!gate.ok) {
          sendError(
            res,
            400,
            "Quality gates failed.",
            { results: gate.results },
            "Review gate output and retry.",
            "gate",
          );
          return;
        }

        const updated = {
          ...items[index],
          status: "done",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        };
        updated.frozen = { core_hash: computeCoreHash(updated) };

        items[index] = updated;
        await writeQueueItems(targetResult.target.storePath, items);
        await writeQueueViews(targetResult.target.storePath, items);

        await appendRunLog(targetResult.target.storePath, {
          ts: new Date().toISOString(),
          kind: "queue_transition",
          target_id: targetResult.target.id,
          queue_id: id,
          commands: [],
          artifacts: [],
          summary: "queue done",
        });

        sendJson(res, 200, { ok: true, id, status: "done" });
        return;
      }

      sendError(res, 400, "Unknown transition.");
    } finally {
      await releaseLock(lockPath);
    }
    return;
  }

  if (pathname === "/api/active" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const records = await readQueueItems(targetResult.target.storePath);
    const items = records
      .map((record) => record.item)
      .filter((item) => item.status === "active");
    const lessonsRecords = await readJsonl(
      path.join(targetResult.target.storePath, "lessons", "items.jsonl"),
    );
    const patternsRecords = await readJsonl(
      path.join(targetResult.target.storePath, "patterns", "items.jsonl"),
    );
    const observations =
      targetResult.target.config.blackboard?.observations ?? [];
    const cycleState = await readState(targetResult.target.storePath);
    let signals = [];
    try {
      const blackboardView = await buildBlackboardView({
        root: targetResult.target.root,
        store: targetResult.target.storePath,
        observations,
        cycleId: cycleState.activeCycleId ?? null,
        deterministic: true,
        readOnly: true,
      });
      signals = blackboardView.signals ?? [];
    } catch (error) {
      const err = error as Error & { code?: number };
      if (err.code !== 3) {
        throw error;
      }
    }
    sendJson(res, 200, {
      ok: true,
      items,
      lessons: lessonsRecords.map((record) => record.item).slice(-3),
      patterns: patternsRecords.map((record) => record.item).slice(-3),
      signals: signals.slice(0, 5),
    });
    return;
  }

  if (pathname === "/api/runs" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const records = await readJsonl(
      getRunLogPath(targetResult.target.storePath),
    );
    const items = records
      .map((record) => record.item)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (pathname === "/api/blackboard" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    try {
      const state = await readState(targetResult.target.storePath);
      const cycleId = state.activeCycleId ?? null;
      const observations =
        targetResult.target.config.blackboard?.observations ?? [];
      const view = await buildBlackboardView({
        root: targetResult.target.root,
        store: targetResult.target.storePath,
        observations,
        cycleId,
        deterministic: true,
        readOnly: true,
      });
      const posts = await readBlackboardPosts(targetResult.target.storePath);
      sendJson(res, 200, {
        ok: true,
        state: {
          generated_at: view.generated_at,
          signals: view.signals,
          posts,
          telemetry: view.telemetry,
        },
      });
    } catch (error) {
      sendError(
        res,
        error?.code ?? 500,
        error?.message ?? "Blackboard view failed.",
        error?.details ?? null,
      );
    }
    return;
  }

  if (pathname === "/api/targets" && method === "GET") {
    const root = await findNearestConfigRoot(process.cwd());
    if (!root) {
      sendError(res, 404, "Unable to locate .ato/config.json.");
      return;
    }
    const { config } = await loadConfig(root);
    if (!config.fingerprintSeed) {
      sendError(
        res,
        400,
        "Missing fingerprintSeed in .ato/config.json.",
        null,
        "Run `ato repo init-seed` to create a seed.",
      );
      return;
    }
    const registryInfo = await loadRegistry(root);
    const entries = (registryInfo?.registry?.targets ?? []).map((entry) => {
      const resolvedRoot = path.resolve(
        path.dirname(registryInfo.registryPath),
        entry.root,
      );
      const fingerprint = computeFingerprint({
        targetId: entry.id,
        storeDir: config.storeDir ?? ".ato",
        seed: config.fingerprintSeed,
      });
      let fingerprintStatus = "unknown";
      if (entry.fingerprint) {
        fingerprintStatus =
          entry.fingerprint === fingerprint ? "match" : "mismatch";
      }
      return {
        id: entry.id,
        root: resolvedRoot,
        storeDir: config.storeDir ?? ".ato",
        fingerprintStatus,
      };
    });
    sendJson(res, 200, {
      ok: true,
      entries,
      registryPath: registryInfo?.registryPath ?? null,
    });
    return;
  }

  if (pathname === "/api/config" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const agents = await readAgentsMetadata(targetResult.target.root);
    sendJson(res, 200, {
      ok: true,
      config: targetResult.target.config,
      agents,
    });
    return;
  }

  if (pathname === "/api/contracts/index" && method === "GET") {
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const indexPath = path.join(
      targetResult.target.storePath,
      "cache",
      "contracts.index.json",
    );
    const index = await readJson(indexPath, null);
    if (!index) {
      sendError(
        res,
        404,
        "Missing contract index.",
        null,
        "Run `ato contract index` first.",
        "contract",
      );
      return;
    }
    sendJson(res, 200, { ok: true, ...index });
    return;
  }

  if (pathname === "/api/contracts/extract" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const refs = Array.isArray(body?.refs) ? body.refs : [];
    if (!refs.length) {
      sendError(res, 400, "Missing contract refs.");
      return;
    }
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const indexPath = path.join(
      targetResult.target.storePath,
      "cache",
      "contracts.index.json",
    );
    const index = await readJson(indexPath, null);
    if (!index) {
      sendError(
        res,
        404,
        "Missing contract index.",
        null,
        "Run `ato contract index` first.",
        "contract",
      );
      return;
    }

    const sections = [];
    for (const ref of refs) {
      const resolved =
        typeof ref === "string"
          ? {
              doc:
                targetResult.target.config.contracts?.platform ??
                targetResult.target.config.contracts,
              section: ref,
            }
          : ref;
      const docPath = path.resolve(targetResult.target.root, resolved.doc);
      const docKey = toContractDocKey(targetResult.target.root, resolved.doc);
      const entry = resolveSectionFromIndex({
        index,
        doc: docKey,
        section: resolved.section,
      });
      if (!entry) {
        sendError(
          res,
          404,
          `Unable to resolve contract section '${resolved.section}'.`,
        );
        return;
      }
      const extracted = await extractSection({
        index,
        doc: docPath,
        section: resolved.section,
        docKey,
      });
      if (extracted) sections.push(extracted);
    }

    sendJson(res, 200, { ok: true, sections });
    return;
  }

  if (pathname === "/api/gate/run" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const mode = body?.mode ?? "full";
    if (!["fast", "full"].includes(mode)) {
      sendError(res, 400, "Invalid gate mode.");
      return;
    }
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: true,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    const lockPath = await acquireWriteLock(targetResult.target);
    try {
      const artifactsDir = getArtifactsDir(
        targetResult.target.storePath,
        null,
        "gate",
      );
      const gate = await runGates({
        root: targetResult.target.root,
        targetId: targetResult.target.id,
        queueId: null,
        mode,
        config: targetResult.target.config,
        artifactsDir,
        env: process.env,
      });
      await appendRunLog(targetResult.target.storePath, {
        ts: new Date().toISOString(),
        kind: "gate_run",
        target_id: targetResult.target.id,
        mode: gate.mode,
        commands: gate.results.map((result) => ({
          cmd: result.command,
          cwd: targetResult.target.root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })),
        artifacts: gate.artifacts,
        summary: `gate ${gate.ok ? "ok" : "fail"}`,
      });

      sendJson(res, 200, {
        ok: gate.ok,
        results: gate.results,
        plan: gate.plan,
      });
    } finally {
      await releaseLock(lockPath);
    }
    return;
  }

  if (pathname === "/api/pack" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const task = body?.task;
    if (!task) {
      sendError(res, 400, "Missing task.");
      return;
    }
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: true,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    const lockPath = await acquireWriteLock(targetResult.target);

    try {
      const budget = Number(
        body?.budget ?? targetResult.target.config.pack?.defaultBudget ?? 2400,
      );
      const format = body?.format ?? "md";
      if (!Number.isFinite(budget) || budget <= 0) {
        sendError(res, 400, "Invalid budget.");
        return;
      }
      if (!["md", "json"].includes(format)) {
        sendError(res, 400, "Invalid format.");
        return;
      }
      const focus = body?.focus ?? null;
      const withCitations =
        body?.with_citations === true || body?.withCitations === true;

      const records = await readQueueItems(targetResult.target.storePath);
      const items = records.map((record) => record.item);
      const schema = await loadQueueSchema();
      const validation = await validateQueueItems({
        items,
        schema,
        config: targetResult.target.config,
        root: targetResult.target.root,
        store: targetResult.target.storePath,
      });
      if (validation.errors.length) {
        sendError(
          res,
          400,
          "Queue validation failed.",
          { errors: validation.errors },
          "Fix validation errors and retry.",
          "validation",
        );
        return;
      }

      let queueItem = null;
      if (body?.queue) {
        queueItem = items.find((item) => item.id === body.queue) ?? null;
      } else {
        const state = await readState(targetResult.target.storePath);
        if (state.activeQueueId) {
          queueItem =
            items.find((item) => item.id === state.activeQueueId) ?? null;
        }
        if (!queueItem) {
          const selection = selectNextItems({
            items: records,
            target: null,
            focus: null,
            limit: 1,
          });
          queueItem = selection.selected[0]?.item ?? null;
        }
      }

      const queueRecord = queueItem
        ? records.find((record) => record.item.id === queueItem?.id) ?? null
        : null;
      const queuePath = toPosixPath(
        path.relative(
          targetResult.target.root,
          path.join(targetResult.target.storePath, "queue", "items.jsonl"),
        ),
      );
      const queueLine = queueRecord?.line ?? null;

      const candidatePaths = deriveCandidatePaths(
        queueItem,
        targetResult.target.root,
      );
      const routers = await resolveRouters({
        target: targetResult.target,
        candidatePaths,
      });

      const contractSections = [];
      const contractRefs = queueItem?.spec?.contract_refs ?? [];

      if (contractRefs.length) {
        const indexPath = path.join(
          targetResult.target.storePath,
          "cache",
          "contracts.index.json",
        );
        const index = await readJson(indexPath, null);
        if (!index) {
          sendError(
            res,
            404,
            "Missing contract index.",
            null,
            "Run `ato contract index` first.",
            "contract",
          );
          return;
        }

        for (const ref of contractRefs.map((ref) =>
          resolveRef(ref, targetResult.target.config),
        )) {
          const docPath = path.resolve(targetResult.target.root, ref.doc);
          const docKey = toContractDocKey(targetResult.target.root, ref.doc);
          const entry = resolveSectionFromIndex({
            index,
            doc: docKey,
            section: ref.section,
          });
          if (!entry) {
            sendError(
              res,
              404,
              `Unable to resolve contract section '${ref.section}'.`,
            );
            return;
          }
          const extracted = await extractSection({
            index,
            doc: docPath,
            section: ref.section,
            docKey,
          });
          if (extracted) {
            contractSections.push({
              ...extracted,
              docPath: toPosixPath(
                path.relative(targetResult.target.root, docPath),
              ),
            });
          }
        }
      }

      const lessonsPath = path.join(
        targetResult.target.storePath,
        "lessons",
        "items.jsonl",
      );
      const patternsPath = path.join(
        targetResult.target.storePath,
        "patterns",
        "items.jsonl",
      );
      const lessonsRecords = await readJsonl(lessonsPath);
      const patternsRecords = await readJsonl(patternsPath);
      const runRecords = await readJsonl(
        path.join(targetResult.target.storePath, "runs", "runs.jsonl"),
      );
      const cycleState = await readState(targetResult.target.storePath);
      const observations =
        targetResult.target.config.blackboard?.observations ?? [];
      let signals = [];
      try {
        const blackboardView = await buildBlackboardView({
          root: targetResult.target.root,
          store: targetResult.target.storePath,
          observations,
          cycleId: cycleState.activeCycleId ?? null,
          deterministic: true,
          readOnly: true,
        });
        signals = blackboardView.signals ?? [];
      } catch (error) {
        const err = error as Error & { code?: number };
        if (err.code !== 3) {
          throw error;
        }
      }

      const lessons = lessonsRecords.map((record) => record.item);
      const patterns = patternsRecords.map((record) => record.item);
      const lessonLineMap = {};
      for (const record of lessonsRecords) {
        if (record.item?.id) {
          lessonLineMap[record.item.id] = record.line;
        }
      }
      const patternLineMap = {};
      for (const record of patternsRecords) {
        if (record.item?.id) {
          patternLineMap[record.item.id] = record.line;
        }
      }
      const runLogEntries = runRecords.map((record) => record.item);

      const lessonSourcePath = toPosixPath(
        path.relative(targetResult.target.root, lessonsPath),
      );
      const patternSourcePath = toPosixPath(
        path.relative(targetResult.target.root, patternsPath),
      );

      const pack = buildPack({
        task,
        focus,
        budget,
        format,
        queueItem,
        queueLine,
        queuePath,
        routers,
        contractSections,
        blackboardSignals: signals,
        lessons,
        lessonLineMap,
        lessonSourcePath,
        patterns,
        patternLineMap,
        patternSourcePath,
        runLogEntries,
        withCitations,
      });

      const artifactDir = getArtifactsDir(
        targetResult.target.storePath,
        queueItem?.id ?? null,
        "pack",
      );
      await ensureDir(artifactDir);
      const artifactPath = path.join(
        artifactDir,
        `pack-${Date.now()}.${format === "json" ? "json" : "md"}`,
      );
      await fs.writeFile(artifactPath, pack.output, "utf8");

      await appendRunLog(targetResult.target.storePath, {
        ts: new Date().toISOString(),
        kind: "pack",
        target_id: targetResult.target.id,
        queue_id: queueItem?.id ?? null,
        commands: [],
        artifacts: [artifactPath],
        summary: `pack${pack.overBudget ? " (over budget)" : ""}`,
      });

      sendJson(res, 200, {
        ok: true,
        output: pack.output,
        path: artifactPath,
        tokens: pack.tokens ?? null,
        overBudget: pack.overBudget,
        requiredTokens: pack.requiredTokens ?? null,
        gaps: pack.gaps ?? [],
        budget,
      });
    } finally {
      await releaseLock(lockPath);
    }
    return;
  }

  if (pathname === "/api/reflect/record" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const id = body?.id;
    if (!id) {
      sendError(res, 400, "Missing id.");
      return;
    }
    const input = parseJsonPayload(body?.input);
    if (!input.ok) {
      sendError(res, 400, input.error);
      return;
    }

    const targetResult = await resolveTargetContext({
      req,
      requireWrite: true,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    await ensureProtocol(targetResult.target.root);
    const lockPath = await acquireWriteLock(targetResult.target);

    try {
      const payload = input.value;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        sendError(res, 400, "Reflection payload must be a JSON object.");
        return;
      }

      const delta = normalizeScan(payload.delta_scan, "delta_scan");
      if (!delta.ok) {
        sendError(res, 400, delta.error);
        return;
      }

      const system = normalizeScan(payload.system_scan, "system_scan");
      if (!system.ok) {
        sendError(res, 400, system.error);
        return;
      }

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
        sendError(
          res,
          400,
          "Reflection requires queue_items or no_actionable_deltas=true.",
        );
        return;
      }
      if (rawQueueItems.length && noActionable) {
        sendError(
          res,
          400,
          "Reflection cannot set no_actionable_deltas with queue_items.",
        );
        return;
      }

      const records = await readQueueItems(targetResult.target.storePath);
      const items = records.map((record) => record.item);
      const schema = await loadQueueSchema();
      const preValidation = await validateQueueItems({
        items,
        schema,
        config: targetResult.target.config,
        root: targetResult.target.root,
        store: targetResult.target.storePath,
      });
      if (preValidation.errors.length) {
        sendError(
          res,
          400,
          "Queue validation failed.",
          { errors: preValidation.errors },
          "Fix validation errors and retry.",
          "validation",
        );
        return;
      }
      const existingIds = new Set(items.map((item) => item.id));
      const createdIds = [];

      for (const entry of rawQueueItems) {
        const built = buildReflectItem({ entry, items, existingIds });
        if (!built.ok) {
          sendError(res, 400, built.error);
          return;
        }
        items.push(built.item);
        createdIds.push(built.id);
        existingIds.add(built.id);
      }

      for (const entryId of createdIds) {
        const item = items.find((entry) => entry.id === entryId);
        if (!item) continue;
        for (const dep of item.deps ?? []) {
          if (!existingIds.has(dep)) {
            sendError(
              res,
              400,
              `queue_items dependency '${dep}' does not exist.`,
            );
            return;
          }
        }
      }

      const index = items.findIndex((entry) => entry.id === id);
      if (index === -1) {
        sendError(res, 404, `Unknown ID: ${id}`);
        return;
      }

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
        const lessons = await readLessonItems(targetResult.target.storePath);
        const lessonIds = new Set(lessons.map((lesson) => lesson.id));
        for (const entry of lessonsToAdd) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            sendError(res, 400, "lessons_to_add entries must be objects.");
            return;
          }
          const nextId = entry.id
            ? String(entry.id).trim()
            : nextLessonId(lessons);
          if (lessonIds.has(nextId)) {
            sendError(res, 400, `lesson id '${nextId}' already exists.`);
            return;
          }
          const lesson = normalizeLessonInput({
            input: { ...entry, id: nextId },
            fallbackId: nextId,
            now: new Date().toISOString(),
          });
          const lessonValidation = await validateLessonItem(lesson);
          if (!lessonValidation.ok) {
            sendError(res, 400, `Invalid lesson '${nextId}'.`, {
              errors: lessonValidation.errors,
            });
            return;
          }
          lessons.push(lesson);
          lessonIds.add(lesson.id);
          addedLessonIds.push(lesson.id);
        }
        if (addedLessonIds.length) {
          await writeLessonItems(targetResult.target.storePath, lessons);
        }
      }

      const addedPatternIds = [];
      if (patternsToAdd.length) {
        const patterns = await readPatternItems(targetResult.target.storePath);
        const patternIds = new Set(patterns.map((pattern) => pattern.id));
        for (const entry of patternsToAdd) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            sendError(res, 400, "patterns_to_add entries must be objects.");
            return;
          }
          const nextId = entry.id
            ? String(entry.id).trim()
            : nextPatternId(patterns);
          if (patternIds.has(nextId)) {
            sendError(res, 400, `pattern id '${nextId}' already exists.`);
            return;
          }
          const pattern = normalizePatternInput({
            input: { ...entry, id: nextId },
            fallbackId: nextId,
            now: new Date().toISOString(),
          });
          const patternValidation = await validatePatternItem(pattern);
          if (!patternValidation.ok) {
            sendError(res, 400, `Invalid pattern '${nextId}'.`, {
              errors: patternValidation.errors,
            });
            return;
          }
          patterns.push(pattern);
          patternIds.add(pattern.id);
          addedPatternIds.push(pattern.id);
        }
        if (addedPatternIds.length) {
          await writePatternItems(targetResult.target.storePath, patterns);
        }
      }

      const postValidation = await validateQueueItems({
        items,
        schema,
        config: targetResult.target.config,
        root: targetResult.target.root,
        store: targetResult.target.storePath,
      });
      if (postValidation.errors.length) {
        sendError(
          res,
          400,
          "Queue validation failed.",
          { errors: postValidation.errors },
          "Fix validation errors and retry.",
          "validation",
        );
        return;
      }

      await writeQueueItems(targetResult.target.storePath, items);
      await appendRunLog(targetResult.target.storePath, {
        ts: new Date().toISOString(),
        kind: "reflect",
        target_id: targetResult.target.id,
        queue_id: id,
        ...(addedLessonIds.length ? { lesson_ids: addedLessonIds } : {}),
        ...(addedPatternIds.length ? { pattern_ids: addedPatternIds } : {}),
        commands: [],
        artifacts: [],
        summary: `reflect record ${id}`,
      });

      const state = await readState(targetResult.target.storePath);
      const nextState = {
        ...state,
        version: state.version ?? 1,
        targetId: targetResult.target.id,
        lastReflect: {
          queueId: id,
          ts: new Date().toISOString(),
        },
      };
      await writeState(targetResult.target.storePath, nextState);

      sendJson(res, 200, {
        ok: true,
        id,
        queue_items: createdIds,
        lessons_added: addedLessonIds,
        patterns_added: addedPatternIds,
      });
    } finally {
      await releaseLock(lockPath);
    }
    return;
  }

  if (pathname === "/api/files" && method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      sendError(res, 400, "Missing file path.");
      return;
    }
    const targetResult = await resolveTargetContext({
      req,
      requireWrite: false,
      defaultSelection,
    });
    if (!targetResult.target) {
      sendError(res, 404, "Target not resolved.");
      return;
    }
    const resolved = path.resolve(filePath);
    const storeRoot = path.resolve(targetResult.target.storePath);
    if (!resolved.startsWith(storeRoot)) {
      sendError(res, 400, "File path outside target store.");
      return;
    }
    if (!(await fileExists(resolved))) {
      sendError(res, 404, "File not found.");
      return;
    }
    await sendFile(res, resolved);
    return;
  }

  sendError(res, 404, "Unknown endpoint.");
};


const focusToRouter = (focus) => {
  const normalized = String(focus ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const map = {
    "ui-primitives": "packages/ui-primitives/AGENTS.md",
    primitives: "packages/ui-primitives/AGENTS.md",
    "ui-tokens": "packages/ui-tokens/AGENTS.md",
    tokens: "packages/ui-tokens/AGENTS.md",
    "ui-shell": "packages/ui-shell/AGENTS.md",
    shell: "packages/ui-shell/AGENTS.md",
    docs: "packages/docs/AGENTS.md",
  };
  return map[normalized] ?? null;
};

const pickFocusFromTags = (tags) => {
  const candidates = ["ui-primitives", "ui-tokens", "ui-shell", "docs"];
  for (const candidate of candidates) {
    if ((tags ?? []).includes(candidate)) return candidate;
  }
  return null;
};

const resolveRef = (ref, config) => {
  if (typeof ref === "string") {
    return {
      doc: config.contracts?.platform ?? config.contracts,
      section: ref,
    };
  }
  return ref;
};

const parseJsonPayload = (input) => {
  if (!input) return { ok: false, error: "Missing JSON input." };
  const raw = String(input).trim();
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: `Unable to parse JSON input: ${error.message}` };
  }
};

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
    { min: 0, allowEmpty: true },
  );
  if (!scope.ok) return { ok: false, error: scope.error };

  const risks = ensureStringArray(
    specInput.risks ?? [],
    "queue_items.spec.risks",
    { min: 0, allowEmpty: true },
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
    owner: entry.owner ?? "codex",
    notes: entry.notes ? String(entry.notes) : "",
    spec,
    details,
  });

  return { ok: true, id, item };
};
