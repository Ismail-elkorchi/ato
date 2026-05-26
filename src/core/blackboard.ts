import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, stableStringify } from "./fs.js";
import type { BlackboardPost } from "./types.js";

export const BLACKBOARD_POST_KINDS = new Set<BlackboardPost["kind"]>([
  "note",
  "question",
  "decision",
  "warning",
]);

export const isBlackboardPostKind = (
  value: string,
): value is BlackboardPost["kind"] =>
  BLACKBOARD_POST_KINDS.has(value as BlackboardPost["kind"]);

export const getBlackboardPaths = (store: string) => {
  const dir = path.join(store, "blackboard");
  return {
    dir,
    inboxDir: path.join(dir, "inbox"),
  };
};

export type BlackboardExportPayload = {
  schema_version: "bb-export.v1";
  exported_at: string;
  origin: {
    repo_id: string | null;
    repo_fingerprint: string | null;
  };
  posts: BlackboardPost[];
};

const normalizeOrigin = (origin?: {
  repo_id?: string | null;
  repo_fingerprint?: string | null;
} | null) => ({
  repo_id: origin?.repo_id ?? null,
  repo_fingerprint: origin?.repo_fingerprint ?? null,
});

const EXPORT_TIMESTAMP_BASE = Date.UTC(2000, 0, 1);
const EXPORT_TIMESTAMP_RANGE_MS = 1000 * 60 * 60 * 24 * 365 * 50;

const buildDeterministicExportedAt = ({
  origin,
  posts,
}: {
  origin: BlackboardExportPayload["origin"];
  posts: BlackboardPost[];
}): string => {
  const seed = stableStringify({
    origin,
    posts,
  });
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const offset =
    parseInt(hash.slice(0, 12), 16) % EXPORT_TIMESTAMP_RANGE_MS;
  return new Date(EXPORT_TIMESTAMP_BASE + offset).toISOString();
};

const buildImportedPostId = (post: BlackboardPost): string => {
  const seed = stableStringify({
    schema_version: post.schema_version,
    created_at: post.created_at,
    kind: post.kind,
    author: post.author,
    scope: post.scope,
    text: post.text,
    payload: post.payload ?? null,
    origin: post.origin ?? null,
  });
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return `import__${hash.slice(0, 32)}`;
};

const normalizeImportedPost = ({
  post,
  fallbackOrigin,
}: {
  post: BlackboardPost;
  fallbackOrigin: BlackboardExportPayload["origin"];
}): BlackboardPost => {
  if (post.schema_version !== "bb-post.v1") {
    throw new Error("Invalid blackboard post schema.");
  }
  if (!post.scope || typeof post.scope.block_id !== "string") {
    throw new Error("Invalid blackboard post scope.");
  }
  if (!/^block-\d{4,}$/.test(post.scope.block_id)) {
    throw new Error("Invalid blackboard post block id.");
  }
  if (!isBlackboardPostKind(post.kind)) {
    throw new Error("Invalid blackboard post kind.");
  }
  if (typeof post.text !== "string" || !post.text.trim()) {
    throw new Error("Invalid blackboard post text.");
  }
  if (typeof post.created_at !== "string" || !post.created_at.trim()) {
    throw new Error("Invalid blackboard post created_at.");
  }
  const sourceId =
    typeof post.id === "string" && post.id.trim() ? post.id.trim() : "source";
  const cycleId =
    typeof post.scope.cycle_id === "string" ? post.scope.cycle_id : null;
  const queueId =
    typeof post.scope.queue_id === "string" ? post.scope.queue_id : null;
  const author =
    typeof post.author === "string" && post.author.trim()
      ? post.author.trim()
      : "unknown";
  const origin = normalizeOrigin(post.origin ?? fallbackOrigin);
  return {
    schema_version: "bb-post.v1",
    id: sourceId,
    created_at: post.created_at,
    kind: post.kind,
    author,
    scope: {
      block_id: post.scope.block_id,
      ...(cycleId ? { cycle_id: cycleId } : {}),
      ...(queueId ? { queue_id: queueId } : {}),
    },
    text: post.text,
    ...(post.payload !== undefined ? { payload: post.payload } : {}),
    trust: "untrusted",
    ...(origin.repo_id || origin.repo_fingerprint ? { origin } : {}),
  };
};

export const writeBlackboardPost = async (
  store: string,
  post: BlackboardPost,
): Promise<{ path: string; sha256: string }> => {
  const { inboxDir } = getBlackboardPaths(store);
  await ensureDir(inboxDir);
  const filePath = path.join(inboxDir, `${post.id}.json`);
  const payload = `${stableStringify(post)}\n`;
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  await fs.writeFile(filePath, payload, { flag: "wx" });
  return { path: filePath, sha256 };
};

export const readBlackboardPosts = async (
  store: string,
): Promise<BlackboardPost[]> => {
  const { inboxDir } = getBlackboardPaths(store);
  let entries: Array<{ name: string }> = [];
  try {
    const dirents = await fs.readdir(inboxDir, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({ name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: Array<{ id: string; sha256: string; post: BlackboardPost }> =
    [];
  for (const entry of entries) {
    const filePath = path.join(inboxDir, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as BlackboardPost;
    const id = parsed?.id ?? entry.name.replace(/\.json$/i, "");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const post: BlackboardPost = { ...parsed, id, trust: "untrusted" };
    records.push({
      id,
      sha256,
      post,
    });
  }

  records.sort((a, b) => {
    const idDiff = a.id.localeCompare(b.id);
    if (idDiff !== 0) return idDiff;
    return a.sha256.localeCompare(b.sha256);
  });

  return records.map((record) => record.post);
};

export const buildBlackboardExport = async ({
  store,
  origin,
  now,
}: {
  store: string;
  origin?: { repo_id?: string | null; repo_fingerprint?: string | null } | null;
  now?: Date;
}): Promise<BlackboardExportPayload> => {
  const posts = await readBlackboardPosts(store);
  const normalizedOrigin = normalizeOrigin(origin);
  return {
    schema_version: "bb-export.v1",
    exported_at: now
      ? now.toISOString()
      : buildDeterministicExportedAt({
          origin: normalizedOrigin,
          posts,
        }),
    origin: normalizedOrigin,
    posts,
  };
};

export const writeBlackboardExport = async (
  filePath: string,
  payload: BlackboardExportPayload,
): Promise<{ path: string; sha256: string }> => {
  await ensureDir(path.dirname(filePath));
  const content = `${stableStringify(payload)}\n`;
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  await fs.writeFile(filePath, content, "utf8");
  return { path: filePath, sha256 };
};

export const importBlackboardPosts = async ({
  store,
  payload,
}: {
  store: string;
  payload: BlackboardExportPayload;
}): Promise<{ imported: number; skipped: number; post_ids: string[] }> => {
  if (payload.schema_version !== "bb-export.v1") {
    throw new Error("Invalid blackboard export schema.");
  }
  if (!Array.isArray(payload.posts)) {
    throw new Error("Invalid blackboard export payload.");
  }
  const fallbackOrigin = normalizeOrigin(payload.origin);
  let imported = 0;
  let skipped = 0;
  const postIds: string[] = [];
  for (const entry of payload.posts) {
    const normalized = normalizeImportedPost({
      post: entry as BlackboardPost,
      fallbackOrigin,
    });
    const postId = buildImportedPostId(normalized);
    const post: BlackboardPost = { ...normalized, id: postId };
    postIds.push(postId);
    try {
      await writeBlackboardPost(store, post);
      imported += 1;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { imported, skipped, post_ids: postIds };
};
