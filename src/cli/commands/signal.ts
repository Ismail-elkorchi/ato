import path from "node:path";

import { parseFlags, writeJson, writeLines, formatTargetLine } from "../utils.js";
import { resolveTargetContext } from "./shared.js";
import {
  readSignalDefinitionCatalog,
  validateSignalDefinitionCatalog,
  SIGNAL_DEFINITION_SCHEMA_ID,
} from "../../core/signals/definitions.js";
import type { SignalDefinition } from "../../core/types.js";
import type { CommandContext } from "../types.js";

const HELP = [
  "Usage:",
  "  ato signal definition list",
  "  ato signal definition validate",
  "",
  "Examples:",
  "  ato signal definition list --json",
  "  ato signal definition validate --json",
].join("\n");

const toPosix = (value: string): string => value.replace(/\\/g, "/");

const sortSignals = (signals: SignalDefinition[]): SignalDefinition[] =>
  [...signals].sort((a, b) => a.name.localeCompare(b.name));

const renderValidation = ({
  json,
  ok,
  catalogPath,
  errors,
}: {
  json: boolean;
  ok: boolean;
  catalogPath: string;
  errors: string[];
}): void => {
  if (json) {
    writeJson({
      ok,
      schema: SIGNAL_DEFINITION_SCHEMA_ID,
      catalog_path: catalogPath,
      errors,
    });
  } else {
    writeLines([
      `validate: ${ok ? "ok" : "fail"}`,
      `catalog: ${catalogPath}`,
      `schema: ${SIGNAL_DEFINITION_SCHEMA_ID}`,
      ...errors.map((error) => `- ${error}`),
    ]);
  }
  if (!ok) {
    process.exitCode = 3;
  }
};

export const runSignalCommand = async ({
  subcommand,
  args,
  context,
}: {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
}): Promise<void> => {
  const json = context.json;
  const { flags, positionals } = parseFlags(args);

  if (!subcommand || flags["help"]) {
    writeLines([HELP]);
    return;
  }

  if (subcommand !== "definition") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown signal subcommand." },
      });
    } else {
      writeLines(["Unknown signal subcommand.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  const action = positionals[0];
  if (!action) {
    writeLines([HELP]);
    return;
  }

  const target = await resolveTargetContext({ context, requireWrite: false });
  const { catalog, path: catalogPath } = await readSignalDefinitionCatalog(
    target.storePath,
  );
  const catalogRel = toPosix(path.relative(target.root, catalogPath));
  const validation = await validateSignalDefinitionCatalog(catalog);

  if (action === "validate") {
    renderValidation({
      json,
      ok: validation.ok,
      catalogPath: catalogRel,
      errors: validation.errors,
    });
    return;
  }

  if (action !== "list") {
    if (json) {
      writeJson({
        ok: false,
        code: 1,
        error: { message: "Unknown signal definition action." },
      });
    } else {
      writeLines(["Unknown signal definition action.", "", HELP]);
    }
    process.exitCode = 1;
    return;
  }

  if (!validation.ok) {
    renderValidation({
      json,
      ok: false,
      catalogPath: catalogRel,
      errors: validation.errors,
    });
    return;
  }

  const signals = sortSignals(catalog);
  if (json) {
    writeJson({
      ok: true,
      schema: SIGNAL_DEFINITION_SCHEMA_ID,
      catalog_path: catalogRel,
      count: signals.length,
      signals,
    });
  } else {
    writeLines([
      formatTargetLine(target),
      `catalog: ${catalogRel}`,
      `schema: ${SIGNAL_DEFINITION_SCHEMA_ID}`,
      `signals: ${signals.length}`,
      ...signals.map((signal) => `- ${signal.name} (${signal.type})`),
    ]);
  }
};
