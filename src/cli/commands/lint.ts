import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJson, writeLines } from "../utils.js";
import { resolveTargetContext } from "./shared.js";
import { readAgentsMetadata, PROTOCOL_VERSION } from "../../core/protocol.js";
import type { CommandContext } from "../types.js";
import type { AtoConfig } from "../../core/types.js";

const listAgentsFiles = async (root: string): Promise<string[]> => {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name.startsWith(".git") ||
        entry.name === ".ato"
      ) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "AGENTS.md") {
        results.push(full);
      }
    }
  }
  return results;
};

const lintProtocol = async (
  root: string,
): Promise<Array<{ file: string; message: string }>> => {
  const { agentsPath, meta } = await readAgentsMetadata(root);
  const errors: Array<{ file: string; message: string }> = [];
  if (!meta.protocolVersion) {
    errors.push({
      file: agentsPath,
      message: "Missing ATO_PROTOCOL_VERSION metadata.",
    });
  } else if (meta.protocolVersion !== PROTOCOL_VERSION) {
    errors.push({
      file: agentsPath,
      message: `Protocol version mismatch. Expected ${PROTOCOL_VERSION}.`,
    });
  }
  if (!meta.minCliVersion) {
    errors.push({
      file: agentsPath,
      message: "Missing ATO_MIN_CLI_VERSION metadata.",
    });
  }
  return errors;
};

const lintTerms = async (
  root: string,
  config: AtoConfig,
): Promise<Array<{ file: string; message: string }>> => {
  const aliases = config?.terminology?.aliases ?? {};
  const required = config?.terminology?.required ?? [];
  const files = await listAgentsFiles(root);
  const errors: Array<{ file: string; message: string }> = [];
  const presence = new Map(required.map((term) => [term, false]));

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    for (const [canonical, variants] of Object.entries(aliases)) {
      for (const variant of variants) {
        const pattern = new RegExp(`\\b${variant}\\b`, "i");
        if (pattern.test(content)) {
          errors.push({
            file,
            message: `Found term alias '${variant}'. Use '${canonical}'.`,
          });
        }
      }
    }
    for (const term of required) {
      const pattern = new RegExp(`\\b${term}\\b`, "i");
      if (pattern.test(content)) {
        presence.set(term, true);
      }
    }
  }

  for (const [term, found] of presence.entries()) {
    if (!found) {
      errors.push({
        file: "AGENTS.md",
        message: `Required term '${term}' not found in any AGENTS.md.`,
      });
    }
  }

  return errors;
};

export const runLintCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  void args;
  const json = context.json;
  const target = await resolveTargetContext({ context, requireWrite: false });

  if (subcommand === "protocol") {
    const errors = await lintProtocol(target.root);
    if (json) {
      writeJson({ ok: errors.length === 0, errors });
    } else {
      writeLines([
        `lint protocol: ${errors.length ? "fail" : "ok"}`,
        ...errors.map((error) => `- ${error.file}: ${error.message}`),
      ]);
    }
    if (errors.length) {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "terms") {
    const errors = await lintTerms(target.root, target.config);
    if (json) {
      writeJson({ ok: errors.length === 0, errors });
    } else {
      writeLines([
        `lint terms: ${errors.length ? "fail" : "ok"}`,
        ...errors.map((error) => `- ${error.file}: ${error.message}`),
      ]);
    }
    if (errors.length) {
      process.exitCode = 1;
    }
    return;
  }

  if (json) {
    writeJson({
      ok: false,
      code: 1,
      error: { message: "Unknown lint subcommand." },
    });
  } else {
    writeLines(["Unknown lint subcommand.", "Usage: ato lint terms|protocol"]);
  }
  process.exitCode = 1;
};
