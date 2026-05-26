import path from "node:path";
import { promises as fs } from "node:fs";
import { createAjv } from "../schemas/ajv.js";

import { readJson } from "../fs.js";
import type { SignalDefinitionCatalog } from "../types.js";

const SIGNAL_DEFINITION_SCHEMA_URL = new URL(
  "../schemas/signal-definition.v1.json",
  import.meta.url,
);

export const SIGNAL_DEFINITION_SCHEMA_ID = "ato://signal-definition.v1.json";

const loadSchema = async (): Promise<unknown> => {
  const raw = await fs.readFile(SIGNAL_DEFINITION_SCHEMA_URL, "utf8");
  return JSON.parse(raw);
};

const buildValidator = async () => {
  const schema = await loadSchema();
  const ajv = createAjv();
  return ajv.compile(schema);
};

export const signalDefinitionCatalogPath = (store: string): string =>
  path.join(store, "signals", "definitions.json");

export const readSignalDefinitionCatalog = async (
  store: string,
): Promise<{ catalog: SignalDefinitionCatalog; path: string }> => {
  const catalogPath = signalDefinitionCatalogPath(store);
  const catalog = await readJson<SignalDefinitionCatalog>(catalogPath, null);
  if (!catalog) {
    const error = new Error(
      `Missing signal definition catalog at ${catalogPath}.`,
    );
    (error as Error & { code?: number }).code = 2;
    throw error;
  }
  return { catalog, path: catalogPath };
};

export const validateSignalDefinitionCatalog = async (
  catalog: SignalDefinitionCatalog,
): Promise<{ ok: boolean; errors: string[] }> => {
  const validate = await buildValidator();
  const ok = validate(catalog);
  const errors = (validate.errors ?? []).map((error) => {
    const prefix = error.instancePath ? `${error.instancePath} ` : "";
    return `${prefix}${error.message ?? "schema error"}`;
  });
  errors.sort((a, b) => a.localeCompare(b));
  return { ok: Boolean(ok), errors };
};
