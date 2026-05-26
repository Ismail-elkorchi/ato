import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import {
  resolveTargetContext,
  ensureProtocol,
  acquireWriteLock,
  releaseWriteLock,
} from "./shared.js";
import {
  writeWorkingSnapshot,
  readLatestWorkingSnapshot,
} from "../../core/memory/working.js";
import {
  buildEpisodicIndex,
  readEpisodicIndex,
  queryEpisodic,
} from "../../core/memory/episodic.js";
import type { EpisodicOutcome } from "../../core/memory/episodic.js";
import {
  addCommitment,
  readCommitments,
  resolveCommitment,
} from "../../core/memory/commitment.js";
import type { CommitmentStatus } from "../../core/memory/commitment.js";
import {
  buildEntityGraph,
  readEntityGraph,
  queryEntityGraph,
} from "../../core/memory/entity.js";
import {
  addProceduralEntry,
  getProceduralEntry,
  runProceduralEntry,
} from "../../core/memory/procedural.js";
import type { ProceduralCommand } from "../../core/memory/procedural.js";
import { parseJsonInput } from "./input.js";
import {
  writeStateSnapshot,
  readLatestStateSnapshot,
  readStateSnapshot,
  listStateSnapshots,
  filterStateSnapshots,
} from "../../core/memory/state.js";
import {
  addCausalLink,
  readCausalLinks,
  queryCausalLinks,
} from "../../core/memory/causal.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage: ato memory <subcommand> [options]",
  "",
  "Subcommands:",
  "  snapshot              Write a working-memory snapshot",
  "  show                  Show the latest working-memory snapshot",
  "  query                 Query episodic memory",
  "  build                 Build an entity memory graph",
  "  record                Record a procedural memory entry",
  "  run                   Run a procedural memory entry",
  "  link                  Record a causal link",
  "  commit                Add a commitment entry",
  "  list                  List commitment entries",
  "  resolve               Mark a commitment resolved",
  "",
  "Options (snapshot):",
  "  --type <working|state> Snapshot type (required)",
  "  --summary <text>      Snapshot summary (working only)",
  "",
  "Options (show):",
  "  --type <working|state> Snapshot type (required)",
  "  --id <id>             Snapshot id (state only)",
  "",
  "Options (query):",
  "  --type <episodic>     Memory type (required)",
  "  --after <iso>         Filter by start timestamp (inclusive)",
  "  --before <iso>        Filter by end timestamp (inclusive)",
  "  --kind <kind>         Filter by run log kind",
  "  --command <text>      Filter by command substring",
  "  --outcome <ok|fail>   Filter by outcome",
  "  --limit <n>           Limit results",
  "  --refresh             Rebuild the episodic index",
  "  --name <text>         Filter entity nodes by name (entity only)",
  "  --file <path>         Filter causal links by file (causal only)",
  "  --mode <or|and>       Causal filter mode (default: or)",
  "",
  "Options (build):",
  "  --type <entity>       Memory type (required)",
  "",
  "Options (record):",
  "  --type <procedural>   Memory type (required)",
  "  --input <json|path>   Procedural entry payload (required)",
  "",
  "Options (run):",
  "  --type <procedural>   Memory type (required)",
  "  --id <id>             Procedural entry id (required)",
  "",
  "Options (link):",
  "  --type <causal>       Memory type (required)",
  "  --command <cmd>       Command to link",
  "  --file <path>         File to link",
  "  --outcome <text>      Outcome description (required)",
  "  --confidence <0-1>    Confidence score (required)",
  "  --queue <id>          Optional queue id provenance",
  "  --run <id>            Optional run id provenance",
  "",
  "Options (commit):",
  "  --type <commitment>   Memory type (required)",
  "  --scope <scope>       Commitment scope (required)",
  "  --owner <owner>       Commitment owner (required)",
  "  --summary <text>      Commitment summary (required)",
  "",
  "Options (list):",
  "  --type <commitment|state> Memory type (required)",
  "  --scope <scope>       Filter by scope (commitment only)",
  "  --status <status>     Filter by status (open|resolved, commitment only)",
  "  --since <iso>         Filter by start timestamp (state only)",
  "  --until <iso>         Filter by end timestamp (state only)",
  "  --limit <n>           Limit results (state only)",
  "",
  "Options (resolve):",
  "  --type <commitment>   Memory type (required)",
  "  --id <id>             Commitment id (required)",
  "",
  "Examples:",
  "  ato memory snapshot --type working --summary \"Focus on queue BL-0023\"",
  "  ato memory show --type working",
  "  ato memory query --type episodic --outcome ok --limit 5",
  "  ato memory build --type entity",
  "  ato memory query --type entity --name ato",
  "  ato memory record --type procedural --input '{\"commands\":[{\"cmd\":\"npm test\"}]}'",
  "  ato memory run --type procedural --id procedural-2025-01-01T00-00-00-000Z",
  "  ato memory link --type causal --command \"npm test\" --outcome \"green\" --confidence 0.8",
  "  ato memory commit --type commitment --scope release --owner ops --summary \"Ship 0.1.0\"",
  "  ato memory list --type commitment --status open",
  "  ato memory list --type state --since 2025-01-01T00:00:00Z --limit 5",
  "  ato memory resolve --type commitment --id commitment-2025-01-01T00-00-00-000Z",
].join("\n");

const requireType = (flags: Record<string, string | boolean>): string => {
  const type = typeof flags["type"] === "string" ? flags["type"] : null;
  if (!type) throw new Error("Missing --type.");
  return type;
};

const parseIso = (value: string | null, label: string): string | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} timestamp.`);
  }
  return new Date(parsed).toISOString();
};

const parseLimit = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid --limit. Use a positive integer.");
  }
  return parsed;
};

const parseOutcome = (value: string | null): EpisodicOutcome | null => {
  if (!value) return null;
  if (value !== "ok" && value !== "fail" && value !== "unknown") {
    throw new Error("Invalid --outcome. Use ok, fail, or unknown.");
  }
  return value;
};

const parseStatus = (value: string | null): CommitmentStatus | null => {
  if (!value) return null;
  if (value !== "open" && value !== "resolved") {
    throw new Error("Invalid --status. Use open or resolved.");
  }
  return value;
};

export const runMemoryCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (
    subcommand !== "snapshot" &&
    subcommand !== "show" &&
    subcommand !== "query" &&
    subcommand !== "build" &&
    subcommand !== "record" &&
    subcommand !== "run" &&
    subcommand !== "link" &&
    subcommand !== "commit" &&
    subcommand !== "list" &&
    subcommand !== "resolve"
  ) {
    if (json) {
      writeJson({ ok: false, code: 1, error: { message: "Unknown memory subcommand." } });
    } else {
      writeLines(["Unknown memory subcommand.", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const type = requireType(flags);
  const target = await resolveTargetContext({ context, requireWrite: true });
  await ensureProtocol(target.root);
  const lockPath = await acquireWriteLock(target, target.config.lock?.ttlMs);
  try {
    if (subcommand === "record") {
      if (type !== "procedural") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const parsed = await parseJsonInput(flags["input"]);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      const payload = parsed.value;
      if (!payload || typeof payload !== "object") {
        throw new Error("--input must be a JSON object.");
      }
      const commandsRaw = (payload as { commands?: unknown }).commands;
      if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) {
        throw new Error("--input must include a non-empty commands array.");
      }
      const commands: ProceduralCommand[] = commandsRaw.map((entry) => {
        if (!entry || typeof entry !== "object") {
          throw new Error("Each command must be an object.");
        }
        const cmd = (entry as { cmd?: unknown }).cmd;
        if (typeof cmd !== "string") {
          throw new Error("Each command must include cmd.");
        }
        const cmdValue = cmd.trim();
        if (!cmdValue) {
          throw new Error("Each command must include cmd.");
        }
        const cwd = (entry as { cwd?: unknown }).cwd;
        const env = (entry as { env?: unknown }).env;
        const input = (entry as { input?: unknown }).input;
        const stdinRequiredRaw = (entry as { stdinRequired?: unknown })
          .stdinRequired;
        const stdinRequiredAlt = (entry as { stdin_required?: unknown })
          .stdin_required;
        const stdinRequired =
          stdinRequiredRaw !== undefined ? stdinRequiredRaw : stdinRequiredAlt;
        if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
          throw new Error("Command cwd must be a string.");
        }
        if (env && (typeof env !== "object" || Array.isArray(env))) {
          throw new Error("Command env must be an object.");
        }
        const envRecord =
          env && typeof env === "object"
            ? Object.fromEntries(
                Object.entries(env as Record<string, unknown>).map(
                  ([key, value]) => [key, String(value)],
                ),
              )
            : undefined;
        if (input !== undefined && input !== null && typeof input !== "string") {
          throw new Error("Command input must be a string.");
        }
        if (stdinRequired !== undefined && typeof stdinRequired !== "boolean") {
          throw new Error("Command stdinRequired must be a boolean.");
        }
        const stdinRequiredFlag = stdinRequired === true;
        const cwdValue = typeof cwd === "string" ? cwd.trim() : undefined;
        const inputValue = typeof input === "string" ? input.trim() : undefined;
        const command: ProceduralCommand = {
          cmd: cmdValue,
          ...(cwdValue !== undefined ? { cwd: cwdValue } : {}),
          ...(envRecord ? { env: envRecord } : {}),
          ...(inputValue !== undefined ? { input: inputValue } : {}),
          ...(stdinRequiredFlag ? { stdinRequired: true } : {}),
        };
        return command;
      });

      const entry = await addProceduralEntry({
        store: target.storePath,
        commands,
      });

      if (json) {
        writeJson({ ok: true, entry });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory record: procedural",
          `id: ${entry.id}`,
          `created: ${entry.createdAt}`,
          `commands: ${entry.commands.length}`,
        ]);
      }
      return;
    }

    if (subcommand === "run") {
      if (type !== "procedural") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const id = typeof flags["id"] === "string" ? flags["id"] : null;
      if (!id) throw new Error("Missing --id.");
      const entry = await getProceduralEntry({
        store: target.storePath,
        id,
      });
      if (!entry) {
        if (json) {
          writeJson({ ok: false, code: 1, error: { message: "Procedural entry not found." } });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory run: procedural",
            "Procedural entry not found.",
          ]);
        }
        process.exitCode = 1;
        return;
      }

      const result = await runProceduralEntry({ root: target.root, entry });

      if (json) {
        writeJson({ ok: result.ok, entryId: entry.id, result });
      } else {
        const lines = [
          formatTargetLine(target),
          "memory run: procedural",
          `entry: ${entry.id}`,
          `ok: ${result.ok ? "yes" : "no"}`,
          `duration: ${result.durationMs}ms`,
        ];
        for (const cmd of result.commands) {
          lines.push(`- ${cmd.cmd} (${cmd.exitCode}, ${cmd.durationMs}ms)`);
        }
        writeLines(lines);
      }
      return;
    }

    if (subcommand === "build") {
      if (type !== "entity") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const graph = await buildEntityGraph({
        root: target.root,
        store: target.storePath,
      });

      if (json) {
        writeJson({
          ok: true,
          graph: {
            version: graph.version,
            generatedAt: graph.generatedAt,
            nodes: graph.nodes,
            edges: graph.edges,
          },
        });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory build: entity",
          `nodes: ${graph.nodes.length}`,
          `edges: ${graph.edges.length}`,
        ]);
      }
      return;
    }

    if (subcommand === "link") {
      if (type !== "causal") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const command =
        typeof flags["command"] === "string" ? flags["command"] : null;
      const file = typeof flags["file"] === "string" ? flags["file"] : null;
      const outcome =
        typeof flags["outcome"] === "string" ? flags["outcome"] : null;
      const confidenceRaw =
        typeof flags["confidence"] === "string" ? flags["confidence"] : null;
      const queueId = typeof flags["queue"] === "string" ? flags["queue"] : null;
      const runId = typeof flags["run"] === "string" ? flags["run"] : null;
      if (!command && !file) {
        throw new Error("Provide --command or --file.");
      }
      if (!outcome) throw new Error("Missing --outcome.");
      if (!confidenceRaw) throw new Error("Missing --confidence.");
      const confidence = Number(confidenceRaw);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error("Invalid --confidence. Use 0-1.");
      }
      const action = command
        ? { type: "command" as const, value: command }
        : { type: "file" as const, value: file ?? "" };
      const provenance =
        queueId || runId
          ? {
              ...(queueId ? { queueId } : {}),
              ...(runId ? { runId } : {}),
            }
          : undefined;
      const entry = await addCausalLink({
        store: target.storePath,
        action,
        outcome,
        confidence,
        ...(provenance ? { provenance } : {}),
      });

      if (json) {
        writeJson({ ok: true, link: entry });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory link: causal",
          `id: ${entry.id}`,
          `action: ${entry.action.type} ${entry.action.value}`,
          `outcome: ${entry.outcome}`,
          `confidence: ${entry.confidence}`,
        ]);
      }
      return;
    }

    if (subcommand === "commit") {
      if (type !== "commitment") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const scope = typeof flags["scope"] === "string" ? flags["scope"] : null;
      const owner = typeof flags["owner"] === "string" ? flags["owner"] : null;
      const summary = typeof flags["summary"] === "string" ? flags["summary"] : null;
      if (!scope) throw new Error("Missing --scope.");
      if (!owner) throw new Error("Missing --owner.");
      if (!summary) throw new Error("Missing --summary.");
      const entry = await addCommitment({
        store: target.storePath,
        scope,
        owner,
        summary,
      });

      if (json) {
        writeJson({ ok: true, entry });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory commit: commitment",
          `id: ${entry.id}`,
          `scope: ${entry.scope}`,
          `owner: ${entry.owner}`,
          `status: ${entry.status}`,
          `created: ${entry.createdAt}`,
          `summary: ${entry.summary}`,
        ]);
      }
      return;
    }

    if (subcommand === "list") {
      if (type === "commitment") {
        const scope = typeof flags["scope"] === "string" ? flags["scope"] : null;
        const status = parseStatus(
          typeof flags["status"] === "string" ? flags["status"] : null,
        );
        const entries = (await readCommitments(target.storePath)).filter(
          (entry) => {
            if (scope && entry.scope !== scope) return false;
            if (status && entry.status !== status) return false;
            return true;
          },
        );

        if (json) {
          writeJson({ ok: true, entries });
        } else {
          const lines = [
            formatTargetLine(target),
            "memory list: commitment",
            `entries: ${entries.length}`,
          ];
          for (const entry of entries) {
            lines.push(
              `- ${entry.id} ${entry.status} scope:${entry.scope} owner:${entry.owner}`,
            );
            lines.push(`  created: ${entry.createdAt}`);
            if (entry.resolvedAt) {
              lines.push(`  resolved: ${entry.resolvedAt}`);
            }
            lines.push(`  summary: ${entry.summary}`);
          }
          writeLines(lines);
        }
        return;
      }

      if (type === "state") {
        const since = parseIso(
          typeof flags["since"] === "string" ? flags["since"] : null,
          "--since",
        );
        const until = parseIso(
          typeof flags["until"] === "string" ? flags["until"] : null,
          "--until",
        );
        const limit = parseLimit(
          typeof flags["limit"] === "string" ? flags["limit"] : null,
        );
        const snapshots = await listStateSnapshots(target.storePath);
        const filtered = filterStateSnapshots({
          snapshots,
          since,
          until,
          limit,
        });
        const entries = filtered.map((snapshot) => ({
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          git: {
            branch: snapshot.git.branch,
            head: snapshot.git.head,
            statusCount: snapshot.git.status.length,
          },
        }));

        if (json) {
          writeJson({ ok: true, entries });
        } else {
          const lines = [
            formatTargetLine(target),
            "memory list: state",
            `entries: ${entries.length}`,
          ];
          for (const entry of entries) {
            lines.push(
              `- ${entry.id} ${entry.createdAt} branch:${entry.git.branch ?? "unknown"} head:${entry.git.head ?? "unknown"} status:${entry.git.statusCount}`,
            );
          }
          writeLines(lines);
        }
        return;
      }

      throw new Error(`Unsupported memory type '${type}'.`);
    }

    if (subcommand === "resolve") {
      if (type !== "commitment") {
        throw new Error(`Unsupported memory type '${type}'.`);
      }
      const id = typeof flags["id"] === "string" ? flags["id"] : null;
      if (!id) throw new Error("Missing --id.");
      const entry = await resolveCommitment({
        store: target.storePath,
        id,
      });
      if (!entry) {
        if (json) {
          writeJson({ ok: false, code: 1, error: { message: "Commitment not found." } });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory resolve: commitment",
            "Commitment not found.",
          ]);
        }
        process.exitCode = 1;
        return;
      }

      if (json) {
        writeJson({ ok: true, entry });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory resolve: commitment",
          `id: ${entry.id}`,
          `status: ${entry.status}`,
          `resolved: ${entry.resolvedAt ?? "n/a"}`,
        ]);
      }
      return;
    }

    if (subcommand === "query") {
      if (type === "episodic") {
        const refresh = Boolean(flags["refresh"]);
        let index = !refresh ? await readEpisodicIndex(target.storePath) : null;
        if (!index) {
          index = await buildEpisodicIndex({ store: target.storePath });
        }

        const after = parseIso(
          typeof flags["after"] === "string" ? flags["after"] : null,
          "--after",
        );
        const before = parseIso(
          typeof flags["before"] === "string" ? flags["before"] : null,
          "--before",
        );
        const kind = typeof flags["kind"] === "string" ? flags["kind"] : null;
        const command =
          typeof flags["command"] === "string" ? flags["command"] : null;
        const outcome = parseOutcome(
          typeof flags["outcome"] === "string" ? flags["outcome"] : null,
        );
        const limit =
          typeof flags["limit"] === "string" ? Number(flags["limit"]) : null;
        if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
          throw new Error("Invalid --limit value.");
        }

        const entries = queryEpisodic({
          index,
          query: { after, before, kind, command, outcome, limit },
        });

        if (json) {
          writeJson({
            ok: true,
            index: {
              version: index.version,
              generatedAt: index.generatedAt,
              source: index.source,
            },
            query: { after, before, kind, command, outcome, limit },
            entries,
          });
        } else {
          const lines = [
            formatTargetLine(target),
            "memory query: episodic",
            `entries: ${entries.length}`,
          ];
          if (entries.length) {
            for (const entry of entries) {
              lines.push(
                `- ${entry.ts} ${entry.kind} ${entry.outcome}${
                  entry.queueId ? ` queue:${entry.queueId}` : ""
                }`,
              );
              if (entry.commands?.length) {
                for (const cmd of entry.commands) {
                  lines.push(
                    `  cmd: ${cmd.cmd} (exit ${cmd.exitCode}, ${cmd.durationMs}ms)`,
                  );
                }
              }
              if (entry.summary) {
                lines.push(`  summary: ${entry.summary}`);
              }
            }
          }
          writeLines(lines);
        }
        return;
      }

      if (type === "entity") {
        const refresh = Boolean(flags["refresh"]);
        let graph = !refresh ? await readEntityGraph(target.storePath) : null;
        if (!graph) {
          graph = await buildEntityGraph({
            root: target.root,
            store: target.storePath,
          });
        }
        const name = typeof flags["name"] === "string" ? flags["name"] : null;
        const result = queryEntityGraph({ graph, name });

        if (json) {
          writeJson({
            ok: true,
            graph: {
              version: graph.version,
              generatedAt: graph.generatedAt,
            },
            query: { name },
            nodes: result.nodes,
            edges: result.edges,
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory query: entity",
            `nodes: ${result.nodes.length}`,
            `edges: ${result.edges.length}`,
          ]);
        }
        return;
      }

      if (type === "causal") {
        const command =
          typeof flags["command"] === "string" ? flags["command"] : null;
        const file = typeof flags["file"] === "string" ? flags["file"] : null;
        const mode =
          typeof flags["mode"] === "string" ? flags["mode"] : "or";
        if (mode !== "or" && mode !== "and") {
          throw new Error("Invalid --mode. Use or or and.");
        }
        const links = await readCausalLinks(target.storePath);
        const entries = queryCausalLinks({
          links,
          command,
          file,
          mode,
        });
        const note =
          mode === "and" && command && file && entries.length === 0
            ? "No entries match both command and file filters."
            : null;
        if (json) {
          writeJson({ ok: true, entries, mode, ...(note ? { note } : {}) });
        } else {
          const lines = [
            formatTargetLine(target),
            "memory query: causal",
            `entries: ${entries.length}`,
            `mode: ${mode}`,
          ];
          if (note) lines.push(note);
          for (const entry of entries) {
            lines.push(
              `- ${entry.action.type} ${entry.action.value} -> ${entry.outcome} (${entry.confidence})`,
            );
          }
          writeLines(lines);
        }
        return;
      }

      throw new Error(`Unsupported memory type '${type}'.`);
    }

    if (subcommand === "snapshot") {
      if (type === "working") {
        const summary =
          typeof flags["summary"] === "string" ? flags["summary"] : null;
        if (!summary) throw new Error("Missing --summary.");
        const result = await writeWorkingSnapshot({
          store: target.storePath,
          summary,
        });

        if (json) {
          writeJson({
            ok: true,
            snapshot: result.snapshot,
            path: result.path,
            latestPath: result.latestPath,
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory snapshot: working",
            `id: ${result.snapshot.id}`,
            `created: ${result.snapshot.createdAt}`,
            `summary length: ${result.snapshot.summaryLength}`,
            `truncated: ${result.snapshot.truncated ? "yes" : "no"}`,
            `path: ${result.path}`,
          ]);
        }
        return;
      }

      if (type === "state") {
        const result = await writeStateSnapshot({
          store: target.storePath,
          root: target.root,
        });
        if (json) {
          writeJson({
            ok: true,
            snapshot: result.snapshot,
            path: result.path,
            latestPath: result.latestPath,
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory snapshot: state",
            `id: ${result.snapshot.id}`,
            `created: ${result.snapshot.createdAt}`,
            `git branch: ${result.snapshot.git.branch ?? "unknown"}`,
            `git head: ${result.snapshot.git.head ?? "unknown"}`,
            `status entries: ${result.snapshot.git.status.length}`,
            `path: ${result.path}`,
          ]);
        }
        return;
      }

      throw new Error(`Unsupported memory type '${type}'.`);
    }

    if (type === "working") {
      const snapshot = await readLatestWorkingSnapshot(target.storePath);
      if (!snapshot) {
        if (json) {
          writeJson({
            ok: false,
            code: 1,
            error: { message: "No working snapshot found." },
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory show: working",
            "No working snapshot found.",
          ]);
        }
        process.exitCode = 1;
        return;
      }

      if (json) {
        writeJson({ ok: true, snapshot });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory show: working",
          `id: ${snapshot.id}`,
          `created: ${snapshot.createdAt}`,
          `summary length: ${snapshot.summaryLength}`,
          `truncated: ${snapshot.truncated ? "yes" : "no"}`,
          "",
          snapshot.summary,
        ]);
      }
      return;
    }

    if (type === "state") {
      const snapshotId = typeof flags["id"] === "string" ? flags["id"] : null;
      const snapshot = snapshotId
        ? await readStateSnapshot({ store: target.storePath, id: snapshotId })
        : await readLatestStateSnapshot(target.storePath);
      if (!snapshot) {
        const message = snapshotId
          ? `State snapshot not found: ${snapshotId}.`
          : "No state snapshot found.";
        if (json) {
          writeJson({
            ok: false,
            code: 1,
            error: { message },
          });
        } else {
          writeLines([
            formatTargetLine(target),
            "memory show: state",
            message,
          ]);
        }
        process.exitCode = 1;
        return;
      }

      if (json) {
        writeJson({ ok: true, snapshot });
      } else {
        writeLines([
          formatTargetLine(target),
          "memory show: state",
          `id: ${snapshot.id}`,
          `created: ${snapshot.createdAt}`,
          `git branch: ${snapshot.git.branch ?? "unknown"}`,
          `git head: ${snapshot.git.head ?? "unknown"}`,
          `status entries: ${snapshot.git.status.length}`,
        ]);
      }
      return;
    }

    throw new Error(`Unsupported memory type '${type}'.`);
  } finally {
    await releaseWriteLock(lockPath);
  }
};
