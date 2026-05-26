import path from "node:path";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createAjv } from "../schemas/ajv.js";

import { readJson } from "../fs.js";

const SCHEMA_URL = new URL("../schemas/baseline-registry.v1.json", import.meta.url);

type BaselineError = {
  kind: string;
  message: string;
};

type BaselineVerifyResult = {
  ok: boolean;
  tag: string;
  registry_path: string;
  errors: BaselineError[];
  guidance: string[];
};

const loadBaselineSchema = async (): Promise<unknown> => {
  const raw = await fs.readFile(SCHEMA_URL, "utf8");
  return JSON.parse(raw);
};

const hashFile = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

const normalizeTag = (tag: string): string => String(tag ?? "").trim();

export const baselineRegistryDir = (store: string): string =>
  path.join(store, "meta", "baselines");

export const baselineRegistryPath = (store: string, tag: string): string =>
  path.join(baselineRegistryDir(store), `${tag}.json`);

export const verifyBaselineRegistry = async ({
  root,
  store,
  tag,
}: {
  root: string;
  store: string;
  tag: string;
}): Promise<BaselineVerifyResult> => {
  const normalizedTag = normalizeTag(tag);
  const errors: BaselineError[] = [];
  const guidance = new Set<string>();

  if (!normalizedTag) {
    errors.push({ kind: "tag_missing", message: "Baseline tag is required." });
    guidance.add("Pass --tag <baseline-tag>.");
  }

  const registryPath = baselineRegistryPath(store, normalizedTag || "unknown");
  const registry = await readJson<Record<string, unknown> | null>(
    registryPath,
    null,
  );
  if (!registry) {
    errors.push({
      kind: "registry_missing",
      message: `Baseline registry missing at ${registryPath}.`,
    });
    guidance.add("Create .ato/meta/baselines/<tag>.json with artifact hashes.");
  }

  const tagResult =
    normalizedTag
      ? spawnSync(
          "git",
          ["-C", root, "rev-parse", "--verify", `${normalizedTag}^{}`],
          { encoding: "utf8" },
        )
      : null;
  const tagExists = Boolean(tagResult && tagResult.status === 0);
  if (normalizedTag && !tagExists) {
    errors.push({
      kind: "tag_not_found",
      message: `Baseline tag '${normalizedTag}' not found.`,
    });
    guidance.add("Create the baseline git tag that points to a full-gate-green commit.");
  }

  if (registry) {
    const schema = await loadBaselineSchema();
    const ajv = createAjv();
    const validate = ajv.compile(schema);
    const ok = validate(registry);
    if (!ok) {
      for (const error of validate.errors ?? []) {
        errors.push({
          kind: "schema",
          message: `${error.instancePath} ${error.message}`,
        });
      }
      guidance.add("Update the baseline registry to match baseline-registry.v1.");
    }

    const artifacts = Array.isArray(registry["artifacts"])
      ? registry["artifacts"]
      : [];
    for (const entry of artifacts) {
      const artifact =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : null;
      const rawPath =
        typeof artifact?.["path"] === "string" ? artifact["path"].trim() : "";
      const sha =
        typeof artifact?.["sha256"] === "string" ? artifact["sha256"].trim() : "";
      if (!rawPath || !sha) continue;
      if (path.isAbsolute(rawPath)) {
        errors.push({
          kind: "absolute_path",
          message: `Baseline artifact path must be repo-relative: ${rawPath}`,
        });
        guidance.add(
          "Rewrite baseline artifact paths under .ato/runs/artifacts/ and re-register.",
        );
        continue;
      }
      const resolved = path.resolve(root, rawPath);
      try {
        const actual = await hashFile(resolved);
        if (actual !== sha) {
          errors.push({
            kind: "sha256_mismatch",
            message: `Baseline artifact sha256 mismatch for ${rawPath}.`,
          });
          guidance.add("Re-materialize baseline artifacts and update the registry.");
        }
      } catch {
        errors.push({
          kind: "artifact_missing",
          message: `Baseline artifact missing: ${rawPath}`,
        });
        guidance.add("Re-materialize baseline artifacts under .ato/runs/artifacts/.");
      }
    }

    const env =
      registry && typeof registry["env"] === "object" && !Array.isArray(registry["env"])
        ? (registry["env"] as Record<string, unknown>)
        : null;
    const lockfile =
      env && typeof env["lockfile"] === "object" && !Array.isArray(env["lockfile"])
        ? (env["lockfile"] as Record<string, unknown>)
        : null;
    const lockPath =
      typeof lockfile?.["path"] === "string" ? lockfile["path"].trim() : "";
    const lockSha =
      typeof lockfile?.["sha256"] === "string" ? lockfile["sha256"].trim() : "";
    if (lockPath && lockSha) {
      if (path.isAbsolute(lockPath)) {
        errors.push({
          kind: "absolute_path",
          message: `Lockfile path must be repo-relative: ${lockPath}`,
        });
        guidance.add("Record lockfile with a repo-relative path in the baseline registry.");
      } else if (tagExists) {
        const show = spawnSync(
          "git",
          ["-C", root, "show", `${normalizedTag}:${lockPath}`],
          { encoding: "utf8" },
        );
        if (show.status !== 0) {
          errors.push({
            kind: "artifact_missing",
            message: `Lockfile missing in baseline tag: ${lockPath}`,
          });
          guidance.add("Ensure the baseline tag contains the recorded lockfile path.");
        } else {
          const actual = crypto
            .createHash("sha256")
            .update(show.stdout)
            .digest("hex");
          if (actual !== lockSha) {
            errors.push({
              kind: "sha256_mismatch",
              message: `Lockfile sha256 mismatch for ${lockPath}.`,
            });
            guidance.add("Re-register baseline lockfile hash if it changed.");
          }
        }
      } else {
        const resolved = path.resolve(root, lockPath);
        try {
          const actual = await hashFile(resolved);
          if (actual !== lockSha) {
            errors.push({
              kind: "sha256_mismatch",
              message: `Lockfile sha256 mismatch for ${lockPath}.`,
            });
            guidance.add("Re-register baseline lockfile hash if it changed.");
          }
        } catch {
          errors.push({
            kind: "artifact_missing",
            message: `Lockfile missing: ${lockPath}`,
          });
          guidance.add("Ensure the lockfile exists at the recorded path.");
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    tag: normalizedTag,
    registry_path: path.relative(root, registryPath).replace(/\\/g, "/"),
    errors,
    guidance: [...guidance],
  };
};
