import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
} from "./shared.js";
import {
  BLACKBOARD_POST_KINDS,
  buildBlackboardExport,
  importBlackboardPosts,
  readBlackboardPosts,
  writeBlackboardExport,
  writeBlackboardPost,
  getBlackboardPaths,
} from "../../core/blackboard.js";
import { buildBlackboardView } from "../../core/blackboard/view.js";
import { readState } from "../../core/state.js";
import { readLatestWorkingSnapshot } from "../../core/memory/working.js";
import { resolveBlockState } from "../../core/blocks/config.js";
import type { CommandContext } from "../types.js";
import type { BlackboardPost } from "../../core/types.js";

const toRelativePath = (root: string, filePath: string): string => {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return rel.replace(/\\/g, "/");
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const formatPathForOutput = (root: string, filePath: string): string => {
  const rel = path.relative(root, filePath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, "/");
  }
  const name = path.basename(filePath);
  return `external:${name || "file"}`;
};

const resolveRepoRelativePath = (root: string, rawPath: string): string => {
  if (path.isAbsolute(rawPath)) {
    throw new Error("bb export --out must be repo-relative.");
  }
  const resolved = path.resolve(root, rawPath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("bb export --out must be within the repo.");
  }
  return resolved;
};

const buildPostId = (now: Date): string => {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${stamp}__${suffix}`;
};

const formatWorkingMemory = ({
  snapshot,
  root,
  store,
}: {
  snapshot: Awaited<ReturnType<typeof readLatestWorkingSnapshot>>;
  root: string;
  store: string;
}) => {
  if (!snapshot) return null;
  const workingPath = path.join(store, "memory", "working", "latest.json");
  return {
    id: snapshot.id,
    created_at: snapshot.createdAt,
    summary: snapshot.summary,
    truncated: snapshot.truncated,
    source_path: toRelativePath(root, workingPath),
  };
};

export const runBlackboardCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;

  if (subcommand === "show") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const state = await readState(target.storePath);
    const cycleId = state.activeCycleId ?? null;
    const observations = target.config.blackboard?.observations ?? [];
    const view = await buildBlackboardView({
      root: target.root,
      store: target.storePath,
      observations,
      cycleId,
      deterministic: true,
      readOnly: true,
    });
    const posts = await readBlackboardPosts(target.storePath);
    const inboxPath = getBlackboardPaths(target.storePath).inboxDir;
    const workingSnapshot = await readLatestWorkingSnapshot(target.storePath);
    const workingMemory = formatWorkingMemory({
      snapshot: workingSnapshot,
      root: target.root,
      store: target.storePath,
    });

    if (json) {
      writeJson({
        ok: true,
        schema_version: "bb-show.v2",
        generated_at: view.generated_at,
        signals: view.signals,
        posts,
        working_memory: workingMemory,
        telemetry: view.telemetry,
        derived: {
          command_log_path: view.artifacts.command_log_path,
          inbox_path: toRelativePath(target.root, inboxPath),
        },
      });
    } else {
      const lines = [
        formatTargetLine(target),
        "blackboard: fresh view",
        `generated: ${view.generated_at}`,
        `signals: ${view.signals.length}`,
        `posts: ${posts.length}`,
      ];
      if (workingMemory) {
        lines.push(`working memory: ${workingMemory.summary}`);
      }
      writeLines(lines);
    }
    return;
  }

  if (subcommand === "post") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const { flags } = parseFlags(args);
    const kindRaw = normalizeString(flags["kind"]).toLowerCase();
    if (!kindRaw || !BLACKBOARD_POST_KINDS.has(kindRaw as BlackboardPost["kind"])) {
      throw new Error(
        "Usage: ato bb post --kind <note|question|decision|warning> --text <text> --block-id block-#### [--cycle-id CY-####] [--queue-id BL-####] [--author name] [--json]",
      );
    }
    const text = normalizeString(flags["text"]);
    if (!text) {
      throw new Error("Missing --text for bb post.");
    }
    let blockId = normalizeString(flags["block-id"]);
    if (!blockId) {
      const blockState = await resolveBlockState(target.storePath);
      blockId = blockState.active_block_id ?? "";
    }
    if (!blockId) {
      throw new Error("Missing --block-id for bb post.");
    }
    if (!/^block-\d{4,}$/.test(blockId)) {
      throw new Error("Invalid --block-id for bb post.");
    }

    const state = await readState(target.storePath);
    const cycleId =
      normalizeString(flags["cycle-id"]) || state.activeCycleId || null;
    const queueId =
      normalizeString(flags["queue-id"]) || state.activeCycleQueueId || null;
    const author =
      normalizeString(flags["author"]) ||
      normalizeString(process.env["USER"]) ||
      "unknown";
    const createdAt = new Date();

    const basePost: BlackboardPost = {
      schema_version: "bb-post.v1",
      id: "pending",
      created_at: createdAt.toISOString(),
      kind: kindRaw as BlackboardPost["kind"],
      author,
      scope: {
        block_id: blockId,
        ...(cycleId ? { cycle_id: cycleId } : {}),
        ...(queueId ? { queue_id: queueId } : {}),
      },
      text,
      trust: "untrusted",
      origin: {
        repo_id: target.id,
        repo_fingerprint: target.fingerprint,
      },
    };

    let attempt = 0;
    let lastError: Error | null = null;
    while (attempt < 5) {
      attempt += 1;
      const postId = buildPostId(createdAt);
      const post = { ...basePost, id: postId };
      try {
        const { path: postPath, sha256 } = await writeBlackboardPost(
          target.storePath,
          post,
        );
        if (json) {
          writeJson({
            ok: true,
            schema_version: "bb-post.v1",
            post_id: postId,
            path: toRelativePath(target.root, postPath),
            sha256,
            post: {
              id: post.id,
              created_at: post.created_at,
              kind: post.kind,
              author: post.author,
              scope: post.scope,
              trust: post.trust,
              origin: post.origin,
            },
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "bb post",
            `id: ${postId}`,
          ]);
        }
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw error;
        lastError = err;
      }
    }
    throw lastError ?? new Error("Unable to write bb post.");
  }

  if (subcommand === "export") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const { flags } = parseFlags(args);
    if (flags["help"]) {
      writeLines([
        "Usage: ato bb export --out <path> [--json]",
        "--out must be repo-relative.",
      ]);
      return;
    }
    const outRaw = normalizeString(flags["out"]);
    if (!outRaw) {
      throw new Error("Missing --out for bb export.");
    }
    const outPath = resolveRepoRelativePath(target.root, outRaw);
    const payload = await buildBlackboardExport({
      store: target.storePath,
      origin: {
        repo_id: target.id,
        repo_fingerprint: target.fingerprint,
      },
    });
    const { path: exportPath, sha256 } = await writeBlackboardExport(
      outPath,
      payload,
    );
    if (json) {
      writeJson({
        ok: true,
        schema_version: "bb-export.v1",
        path: toRelativePath(target.root, exportPath),
        sha256,
        post_count: payload.posts.length,
        origin: payload.origin,
      });
    } else {
      writeLines([
        formatTargetLine(target),
        "bb export",
        `path: ${toRelativePath(target.root, exportPath)}`,
        `posts: ${payload.posts.length}`,
      ]);
    }
    return;
  }

  if (subcommand === "import") {
    const target = await resolveTargetContext({ context, requireWrite: false });
    await ensureProtocol(target.root);
    const { flags } = parseFlags(args);
    if (flags["help"]) {
      writeLines([
        "Usage: ato bb import --from <file> --allow-external [--json]",
        "--allow-external is required for cross-repo posts.",
      ]);
      return;
    }
    if (!flags["allow-external"]) {
      throw new Error("bb import requires --allow-external.");
    }
    const fromRaw = normalizeString(flags["from"]);
    if (!fromRaw) {
      throw new Error("Missing --from for bb import.");
    }
    const sourcePath = path.isAbsolute(fromRaw)
      ? fromRaw
      : path.resolve(target.root, fromRaw);
    const content = await fs.readFile(sourcePath, "utf8");
    const payload = JSON.parse(content);
    const result = await importBlackboardPosts({
      store: target.storePath,
      payload,
    });
    if (json) {
      writeJson({
        ok: true,
        schema_version: "bb-import.v1",
        source: formatPathForOutput(target.root, sourcePath),
        imported: result.imported,
        skipped: result.skipped,
        post_ids: result.post_ids,
      });
    } else {
      writeLines([
        formatTargetLine(target),
        "bb import",
        `source: ${formatPathForOutput(target.root, sourcePath)}`,
        `imported: ${result.imported}`,
        `skipped: ${result.skipped}`,
      ]);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown bb subcommand." },
    });
  } else {
    writeLines([
      "Unknown bb subcommand.",
      "Usage: ato bb show|post|export|import",
    ]);
  }
  process.exitCode = 1;
};
