import { parseFlags, writeJson, writeLines } from "../utils.js";
import {
  buildDashboardAssets,
  startDashboardServer,
} from "../../dashboard/server.js";
import type { CommandContext } from "../types.js";

const DEFAULT_PORT = 4173;

const HELP = [
  "Usage: ato dashboard build|serve [options]",
  "",
  "Options:",
  "  --port <number>   Port for dashboard server (serve)",
].join("\n");

export const runDashboardCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;

  if (subcommand === "build") {
    const outputDir = await buildDashboardAssets();
    if (json) {
      writeJson({ ok: true, outputDir });
    } else {
      writeLines([`dashboard build: ${outputDir}`]);
    }
    return;
  }

  if (subcommand === "serve") {
    const { flags } = parseFlags(args);
    const portValue =
      typeof flags["port"] === "string" ? flags["port"] : DEFAULT_PORT;
    const port = Number(portValue);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error("Invalid --port. Provide a number between 1 and 65535.");
    }
    const defaultSelection = context.repo ?? process.env["ATO_REPO"] ?? null;
    const result = (await startDashboardServer({
      port,
      defaultSelection,
    })) as { port: number };
    const url = `http://localhost:${result.port}/`;
    if (json) {
      writeJson({ ok: true, port: result.port, url });
    } else {
      writeLines([
        "dashboard server running:",
        url,
        defaultSelection ? `default target: ${defaultSelection}` : null,
        "Press Ctrl+C to stop.",
      ]);
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown dashboard subcommand." },
    });
  } else {
    writeLines(["Unknown dashboard subcommand.", HELP]);
  }
  process.exitCode = 1;
};
