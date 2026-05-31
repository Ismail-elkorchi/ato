#!/usr/bin/env node
import { writeError, writeLines } from "./utils.js";
import { runRepoCommand } from "./commands/repo.js";
import { runQueueCommand } from "./commands/q.js";
import { runGateCommand } from "./commands/gate.js";
import { runPackCommand } from "./commands/pack.js";
import { runReflectCommand } from "./commands/reflect.js";
import { runContractCommand } from "./commands/contract.js";
import { runRouteCommand } from "./commands/route.js";
import { runBlackboardCommand } from "./commands/bb.js";
import { runLintCommand } from "./commands/lint.js";
import { runProtocolCommand } from "./commands/protocol.js";
import { runStatusCommand } from "./commands/status.js";
import { runCycleCommand } from "./commands/cycle.js";
import { runLessonCommand } from "./commands/lesson.js";
import { runPatternCommand } from "./commands/pattern.js";
import { runInitCommand } from "./commands/init.js";
import { runDiagnoseCommand } from "./commands/diagnose.js";
import { runCapabilityCommand } from "./commands/capability.js";
import { runPluginCommand } from "./commands/plugin.js";
import { runBaselineCommand } from "./commands/baseline.js";
import { runBlockCommand } from "./commands/block.js";
import { runDevCommand } from "./commands/dev.js";
import { runImpactCommand } from "./commands/impact.js";
import { runTestCommand } from "./commands/qa.js";
import { runTraceCommand } from "./commands/trace.js";
import { runDepsCommand } from "./commands/deps.js";
import { runDocsCommand } from "./commands/docs.js";
import { runSignalCommand } from "./commands/signal.js";
import { runLockCommand } from "./commands/lock.js";
import { runGitCommand } from "./commands/git.js";
import { runMemoryCommand } from "./commands/memory.js";
import { runSessionCommand } from "./commands/session.js";
import type { CommandContext } from "./types.js";

const HELP = [
  "ato - Agent Task Orchestrator",
  "",
  "Usage:",
  "  ato <command> <subcommand> [options]",
  "",
  "Commands:",
  "  init",
  "  repo resolve|list|init-seed",
  "  q add|update|validate|view|list|trace|intake|transfer|contract-refs",
  "  gate run|explain",
  "  reflect record|run",
  "  plugin add",
  "  lesson add",
  "  pattern add|apply",
  "  pack [verify]",
  "  diagnose",
  "  capability list|explain",
  "  baseline verify",
  "  block seal verify|report|close|open",
  "  contract index|extract|compliance",
  "  dev run",
  "  trace run",
  "  deps build|query|lint",
  "  lock status|clear",
  "  git status|locks|plan clean|plan commit|plan stash|plan restore",
  "  docs delta|truth",
  "  session closeout",
  "  signal definition list|validate",
  "  memory snapshot|show|query|build|record|run|link|commit|list|resolve",
  "  impact build|query",
  "  test select",
  "  route index|pack",
  "  bb show|post|export|import",
  "  protocol check",
  "  lint terms|protocol",
  "  status",
  "  cycle start|finish|abort",
  "",
  "Global options:",
  "  --repo <id|path>     Repo id or root path",
  "  --store <path>       Explicit store path",
  "  --json               Emit machine-readable JSON",
  "  --no-plugins         Disable plugin hooks",
  "  --help               Show help",
].join("\n");

const HELP_TOKENS = new Set(["--help", "-h", "help"]);

const TOP_LEVEL_COMMAND_HELP: Record<string, string[]> = {
  init: ["Usage: ato init [options]"],
  repo: ["Usage: ato repo resolve|list|init-seed [options]"],
  q: ["Usage: ato q <subcommand> [options]"],
  gate: ["Usage: ato gate run|explain [options]"],
  reflect: ["Usage: ato reflect record|run [options]"],
  plugin: ["Usage: ato plugin add [options]"],
  lesson: ["Usage: ato lesson add [options]"],
  pattern: ["Usage: ato pattern add|apply [options]"],
  pack: ["Usage: ato pack [verify] [options]"],
  diagnose: ["Usage: ato diagnose [options]"],
  capability: ["Usage: ato capability list|explain [options]"],
  baseline: ["Usage: ato baseline verify [options]"],
  block: ["Usage: ato block seal verify|report|close|open [options]"],
  contract: ["Usage: ato contract index|extract|compliance [options]"],
  dev: ["Usage: ato dev run [options]"],
  trace: ["Usage: ato trace run [options]"],
  deps: ["Usage: ato deps build|query|lint [options]"],
  lock: ["Usage: ato lock status|clear [options]"],
  git: ["Usage: ato git status|locks|plan clean|plan commit|plan stash|plan restore [options]"],
  docs: ["Usage: ato docs delta|truth [options]"],
  session: ["Usage: ato session closeout [options]"],
  signal: ["Usage: ato signal definition list|validate [options]"],
  memory: ["Usage: ato memory snapshot|show|query|build|record|run|link|commit|list|resolve [options]"],
  impact: ["Usage: ato impact build|query [options]"],
  test: ["Usage: ato test select [options]"],
  route: ["Usage: ato route index|pack [options]"],
  bb: ["Usage: ato bb show|post|export|import [options]"],
  protocol: ["Usage: ato protocol check [options]"],
  lint: ["Usage: ato lint terms|protocol [options]"],
  status: ["Usage: ato status [options]"],
  cycle: ["Usage: ato cycle start|finish|abort [options]"],
};

const parseGlobal = (argv: string[]) => {
  const global: {
    json: boolean;
    repo: string | null;
    store: string | null;
    help: boolean;
    pluginsEnabled: boolean;
    misplacedRepo: boolean;
    misplacedRepoValue: string | null;
    misplacedStore: boolean;
    misplacedStoreValue: string | null;
  } = {
    json: false,
    repo: null,
    store: null,
    help: false,
    pluginsEnabled: true,
    misplacedRepo: false,
    misplacedRepoValue: null,
    misplacedStore: false,
    misplacedStoreValue: null,
  };
  const rest: string[] = [];
  let commandSeen = false;
  let commandToken: string | null = null;
  let subcommandToken: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--json") {
      global.json = true;
      continue;
    }
    if (arg === "--repo") {
      if (commandSeen) {
        global.misplacedRepo = true;
        const value = argv[i + 1];
        if (value && !value.startsWith("--")) {
          global.misplacedRepoValue = value;
        }
        rest.push(arg);
        continue;
      }
      const value = argv[i + 1];
      if (value) {
        global.repo = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--store") {
      if (commandSeen) {
        global.misplacedStore = true;
        const value = argv[i + 1];
        if (value && !value.startsWith("--")) {
          global.misplacedStoreValue = value;
        }
        rest.push(arg);
        continue;
      }
      const value = argv[i + 1];
      if (value) {
        global.store = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      if (commandSeen) {
        rest.push(arg);
      } else {
        global.help = true;
      }
      continue;
    }
    if (arg === "--no-plugins") {
      global.pluginsEnabled = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      commandSeen = true;
      if (!commandToken) {
        commandToken = arg;
      } else if (!subcommandToken) {
        subcommandToken = arg;
      }
    }
    rest.push(arg);
  }
  return { global, rest };
};

const run = async (): Promise<void> => {
  const { global, rest } = parseGlobal(process.argv.slice(2));
  const command = rest[0];
  const subcommand = rest[1] ?? null;
  const args = rest.slice(2);

  if (!command || global.help) {
    writeLines([HELP]);
    return;
  }

  const topLevelHelpRequested = Boolean(
    command &&
      subcommand &&
      HELP_TOKENS.has(subcommand) &&
      args.length === 0,
  );
  if (topLevelHelpRequested) {
    const help = TOP_LEVEL_COMMAND_HELP[command];
    if (help) {
      writeLines(help);
      return;
    }
  }

  const context: CommandContext = {
    json: global.json,
    repo: global.repo,
    store: global.store,
    pluginsEnabled: global.pluginsEnabled,
  };

  try {
    if (global.misplacedRepo) {
      const error = new Error(
        "Global --repo must appear before the command token. Example: ato --repo . q list --json",
      );
      (error as Error & { code?: number }).code = 1;
      throw error;
    }
    if (global.misplacedStore) {
      const error = new Error(
        "Global --store must appear before the command token. Example: ato --store /abs/path/to/store status --json",
      );
      (error as Error & { code?: number }).code = 1;
      throw error;
    }
    switch (command) {
      case "repo":
        await runRepoCommand({ subcommand, args, context });
        break;
      case "q":
        await runQueueCommand({ subcommand, args, context });
        break;
      case "gate":
        await runGateCommand({ subcommand, args, context });
        break;
      case "pack":
        await runPackCommand({
          args: [subcommand, ...args].filter(
            (value): value is string => Boolean(value),
          ),
          context,
        });
        break;
      case "diagnose":
        await runDiagnoseCommand({
          args: [subcommand, ...args].filter(
            (value): value is string => Boolean(value),
          ),
          context,
        });
        break;
      case "reflect":
        await runReflectCommand({ subcommand, args, context });
        break;
      case "plugin":
        await runPluginCommand({ subcommand, args, context });
        break;
      case "contract":
        await runContractCommand({ subcommand, args, context });
        break;
      case "baseline":
        await runBaselineCommand({ subcommand, args, context });
        break;
      case "block":
        await runBlockCommand({ subcommand, args, context });
        break;
      case "route":
        await runRouteCommand({ subcommand, args, context });
        break;
      case "bb":
        await runBlackboardCommand({ subcommand, args, context });
        break;
      case "lint":
        await runLintCommand({ subcommand, args, context });
        break;
      case "protocol":
        await runProtocolCommand({ subcommand, args, context });
        break;
      case "status":
        await runStatusCommand({
          args: [subcommand, ...args].filter(
            (value): value is string => Boolean(value),
          ),
          context,
        });
        break;
      case "cycle":
        await runCycleCommand({ subcommand, args, context });
        break;
      case "lesson":
        await runLessonCommand({ subcommand, args, context });
        break;
      case "pattern":
        await runPatternCommand({ subcommand, args, context });
        break;
      case "init":
        await runInitCommand({
          args: [subcommand, ...args].filter(
            (value): value is string => Boolean(value),
          ),
          context,
        });
        break;
      case "capability":
        await runCapabilityCommand({ subcommand, args, context });
        break;
      case "dev":
        await runDevCommand({ subcommand, args, context });
        break;
      case "deps":
        await runDepsCommand({ subcommand, args, context });
        break;
      case "lock":
        await runLockCommand({ subcommand, args, context });
        break;
      case "git":
        await runGitCommand({ subcommand, args, context });
        break;
      case "docs":
        await runDocsCommand({ subcommand, args, context });
        break;
      case "signal":
        await runSignalCommand({ subcommand, args, context });
        break;
      case "memory":
        await runMemoryCommand({ subcommand, args, context });
        break;
      case "session":
        await runSessionCommand({ subcommand, args, context });
        break;
      case "impact":
        await runImpactCommand({ subcommand, args, context });
        break;
      case "trace":
        await runTraceCommand({ subcommand, args, context });
        break;
      case "test":
        await runTestCommand({ subcommand, args, context });
        break;
      default:
        writeLines([`Unknown command: ${command}`, "", HELP]);
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    const failure = error as {
      code?: number | string;
      message?: string;
      details?: unknown;
    };
    const rawCode = failure.code ?? 1;
    const exitCode =
      typeof rawCode === "number" && Number.isFinite(rawCode)
        ? rawCode
        : rawCode === "ATO_NOT_INITIALIZED"
          ? 3
          : 1;
    writeError(
      {
        message: failure.message ?? String(error),
        code: rawCode,
        details: failure.details,
      },
      { json: global.json },
    );
    process.exitCode = exitCode;
  }
};

await run();
