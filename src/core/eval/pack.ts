import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, writeJson } from "../fs.js";
import type { CyclePackRef } from "../types.js";

type CyclePackEntry = { path: string; sha256: string };

export type CyclePackManifest = {
  schema_version: "cycle-pack-manifest.v1";
  cycle_id: string;
  pack_path: string;
  pack_sha256: string;
  entries: CyclePackEntry[];
};

export type PackVerifyFailure = {
  type: string;
  message: string;
  path?: string;
  expected?: string;
  actual?: string;
  value?: string;
};

export type PackVerifyResult = {
  ok: boolean;
  schema_version: "pack-verify.v1";
  cycle_id: string;
  pack_path: string;
  pack_sha256: string;
  manifest_path: string;
  verified_files_count: number;
  required_files: string[];
  missing_required: string[];
  failures: PackVerifyFailure[];
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const normalizePackPath = (root: string, value: string): string => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(root, trimmed);
  const relative = path.relative(root, resolved);
  if (!relative || relative === "." || relative.startsWith("..")) {
    throw new Error(`Pack entry must be within the repo: ${trimmed}`);
  }
  return toPosixPath(relative);
};

const stripEvidencePrefix = (value: string): string => {
  const match = value.match(/^(file|output):(.+)$/);
  return match && match[2] ? match[2].trim() : value.trim();
};

const hashBufferSha256 = (data: Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return hashBufferSha256(data);
};

const looksAbsolutePath = (value: string): boolean => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  const stripped = stripEvidencePrefix(trimmed);
  if (path.isAbsolute(stripped) || path.win32.isAbsolute(stripped)) return true;
  return /(^|[^A-Za-z0-9])\/(home|Users)\//.test(trimmed) || /^[A-Za-z]:\\/.test(trimmed);
};

const ABSOLUTE_PATH_IGNORE_KEYS = new Set([
  "cmd",
  "command",
  "commandLine",
  "command_line",
]);

const collectAbsolutePaths = (
  value: unknown,
  found: string[],
  key?: string | null,
): void => {
  if (key && ABSOLUTE_PATH_IGNORE_KEYS.has(key)) return;
  if (typeof value === "string") {
    if (looksAbsolutePath(value)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAbsolutePaths(entry, found, null);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (looksAbsolutePath(key)) found.push(key);
      collectAbsolutePaths(entry, found, key);
    }
  }
};

const isSafeTarPath = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) return false;
  return !normalized.split("/").includes("..");
};

const deriveManifestPath = (packPath: string): string => {
  if (packPath.endsWith(".tar")) {
    return packPath.slice(0, -4) + ".manifest.json";
  }
  return `${packPath}.manifest.json`;
};

export const requiredCyclePackEntries = (cycleId: string): string[] => [
  `.ato/cycles/${cycleId}/preflight.json`,
  `.ato/cycles/${cycleId}/selection.json`,
  `.ato/cycles/${cycleId}/cycle-start.json`,
  `.ato/cycles/${cycleId}/contract-index.json`,
  `.ato/cycles/${cycleId}/contract-extract.json`,
  `.ato/cycles/${cycleId}/gate-full.json`,
  `.ato/cycles/${cycleId}/q-evidence-add.json`,
];

const writeString = (
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void => {
  buffer.fill(0, offset, offset + length);
  if (!value) return;
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
};

const writeOctal = (
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void => {
  const octal = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, `${octal}\0`);
};

const splitTarPath = (value: string): { name: string; prefix: string } => {
  if (Buffer.byteLength(value) <= 100) {
    return { name: value, prefix: "" };
  }
  const parts = value.split("/");
  for (let idx = parts.length - 1; idx > 0; idx -= 1) {
    const name = parts.slice(idx).join("/");
    const prefix = parts.slice(0, idx).join("/");
    if (
      Buffer.byteLength(name) <= 100 &&
      Buffer.byteLength(prefix) <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Pack entry path too long for tar: ${value}`);
};

const buildTarHeader = (value: string, size: number): Buffer => {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(value);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumStr = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, checksumStr);
  header[154] = 0;
  header[155] = 0x20;
  return header;
};

const readString = (buffer: Buffer, offset: number, length: number): string =>
  buffer
    .toString("utf8", offset, offset + length)
    .replace(/\0.*$/, "")
    .trimEnd();

const readOctal = (buffer: Buffer, offset: number, length: number): number => {
  const raw = readString(buffer, offset, length).trim();
  if (!raw) return 0;
  return parseInt(raw, 8);
};

const writeTarArchive = async ({
  root,
  entries,
  outputPath,
}: {
  root: string;
  entries: CyclePackEntry[];
  outputPath: string;
}): Promise<string> => {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const resolved = path.resolve(root, entry.path);
    const data = await fs.readFile(resolved);
    const header = buildTarHeader(entry.path, data.length);
    chunks.push(header, data);
    const remainder = data.length % 512;
    if (remainder) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, Buffer.concat(chunks));
  const archive = await fs.readFile(outputPath);
  return hashBufferSha256(archive);
};

const readTarArchive = async (
  packPath: string,
): Promise<Map<string, Buffer>> => {
  const data = await fs.readFile(packPath);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${name || "<unknown>"}`);
    }
    const entryPath = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    const content = data.subarray(offset, offset + size);
    entries.set(entryPath, Buffer.from(content));
    const remainder = size % 512;
    offset += size + (remainder ? 512 - remainder : 0);
  }
  return entries;
};

export const buildCycleEvidencePack = async ({
  root,
  store,
  cycleId,
  entries,
}: {
  root: string;
  store: string;
  cycleId: string;
  entries: string[];
}): Promise<{
  pack_ref: CyclePackRef;
  manifest: CyclePackManifest;
}> => {
  const packDir = path.join(store, "packs");
  const packPath = path.join(packDir, `${cycleId}.tar`);
  const manifestPath = path.join(packDir, `${cycleId}.manifest.json`);
  const packRel = toPosixPath(path.relative(root, packPath));
  const manifestRel = toPosixPath(path.relative(root, manifestPath));

  const normalized = entries
    .map((entry) => stripEvidencePrefix(String(entry ?? "")))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => normalizePackPath(root, entry))
    .filter((entry) => entry !== packRel && entry !== manifestRel);

  const unique = [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
  if (!unique.length) {
    throw new Error("Evidence pack requires at least one artifact.");
  }

  const manifestEntries: CyclePackEntry[] = [];
  for (const entry of unique) {
    const resolved = path.resolve(root, entry);
    const data = await fs.readFile(resolved);
    manifestEntries.push({
      path: entry,
      sha256: hashBufferSha256(data),
    });
  }

  const packSha = await writeTarArchive({
    root,
    entries: manifestEntries,
    outputPath: packPath,
  });

  const manifest: CyclePackManifest = {
    schema_version: "cycle-pack-manifest.v1",
    cycle_id: cycleId,
    pack_path: packRel,
    pack_sha256: packSha,
    entries: manifestEntries,
  };
  await writeJson(manifestPath, manifest);

  const packRef: CyclePackRef = {
    kind: "cycle_pack",
    cycle_id: cycleId,
    path: packRel,
    sha256: packSha,
    manifest_path: manifestRel,
  };

  return { pack_ref: packRef, manifest };
};

const normalizeOutputPath = (root: string, value: string): string =>
  toPosixPath(path.relative(root, value));

const parseManifestEntries = (raw: unknown): CyclePackEntry[] => {
  if (!Array.isArray(raw)) return [];
  const entries: CyclePackEntry[] = [];
  for (const entry of raw) {
    const item =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null;
    const entryPath =
      typeof item?.["path"] === "string" ? item["path"].trim() : "";
    const sha =
      typeof item?.["sha256"] === "string" ? item["sha256"].trim() : "";
    if (!entryPath || !sha) continue;
    entries.push({ path: entryPath, sha256: sha });
  }
  return entries;
};

const parseManifest = (
  raw: unknown,
): {
  schemaVersion: string;
  cycleId: string;
  packPath: string;
  packSha: string;
  entries: CyclePackEntry[];
} => {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const schemaVersion =
    typeof source["schema_version"] === "string"
      ? source["schema_version"].trim()
      : "";
  const cycleId =
    typeof source["cycle_id"] === "string" ? source["cycle_id"].trim() : "";
  const packPath =
    typeof source["pack_path"] === "string" ? source["pack_path"].trim() : "";
  const packSha =
    typeof source["pack_sha256"] === "string"
      ? source["pack_sha256"].trim()
      : "";
  const entries = parseManifestEntries(source["entries"]);
  return { schemaVersion, cycleId, packPath, packSha, entries };
};

export const verifyCycleEvidencePack = async ({
  root,
  packPath,
  manifestPath,
  expectedPackSha,
  requiredEntries,
}: {
  root: string;
  packPath: string;
  manifestPath?: string;
  expectedPackSha?: string | null;
  requiredEntries?: string[] | null;
}): Promise<PackVerifyResult> => {
  const packAbs = path.isAbsolute(packPath)
    ? packPath
    : path.resolve(root, packPath);
  const packRel = normalizeOutputPath(root, packAbs);
  const manifestAbs = manifestPath
    ? path.isAbsolute(manifestPath)
      ? manifestPath
      : path.resolve(root, manifestPath)
    : path.resolve(root, deriveManifestPath(packPath));
  const manifestRel = normalizeOutputPath(root, manifestAbs);

  const failures: PackVerifyFailure[] = [];
  let packSha = "";
  let packEntries: Map<string, Buffer> = new Map<string, Buffer>();
  try {
    packSha = await hashFileSha256(packAbs);
  } catch {
    failures.push({
      type: "pack_missing",
      message: `Pack not found: ${packRel}`,
      path: packRel,
    });
  }

  try {
    if (packSha) {
      packEntries = await readTarArchive(packAbs);
    }
  } catch (error) {
    failures.push({
      type: "pack_read_failed",
      message: `Unable to read pack: ${(error as Error).message}`,
      path: packRel,
    });
  }

  let manifestRaw: unknown = null;
  try {
    const manifestData = await fs.readFile(manifestAbs, "utf8");
    manifestRaw = JSON.parse(manifestData);
  } catch {
    failures.push({
      type: "manifest_missing",
      message: `Manifest not found: ${manifestRel}`,
      path: manifestRel,
    });
  }

  const manifest = parseManifest(manifestRaw);
  const derivedCycleMatch = packRel.match(/CY-\d{4,}/);
  const cycleId = manifest.cycleId || derivedCycleMatch?.[0] || "unknown";
  if (manifest.schemaVersion && manifest.schemaVersion !== "cycle-pack-manifest.v1") {
    failures.push({
      type: "manifest_schema",
      message: `Unexpected manifest schema: ${manifest.schemaVersion}`,
      path: manifestRel,
    });
  }
  if (!manifest.cycleId) {
    failures.push({
      type: "manifest_cycle_id_missing",
      message: "Manifest missing cycle_id.",
      path: manifestRel,
    });
  }
  if (manifest.packPath && manifest.packPath !== packRel) {
    failures.push({
      type: "manifest_pack_path_mismatch",
      message: "Manifest pack_path does not match pack path.",
      path: manifestRel,
      expected: packRel,
      actual: manifest.packPath,
    });
  }
  if (manifest.packSha && packSha && manifest.packSha !== packSha) {
    failures.push({
      type: "manifest_pack_sha_mismatch",
      message: "Manifest pack_sha256 does not match pack file.",
      path: manifestRel,
      expected: manifest.packSha,
      actual: packSha,
    });
  }
  if (expectedPackSha && packSha && expectedPackSha !== packSha) {
    failures.push({
      type: "pack_sha_mismatch",
      message: "Pack sha256 does not match expected value.",
      path: packRel,
      expected: expectedPackSha,
      actual: packSha,
    });
  }

  const manifestEntries = manifest.entries ?? [];
  const entryMap = new Map<string, string>();
  for (const entry of manifestEntries) {
    if (!entry.path || !entry.sha256) continue;
    if (!isSafeTarPath(entry.path)) {
      failures.push({
        type: "manifest_entry_path_invalid",
        message: `Manifest entry path is invalid: ${entry.path}`,
        path: entry.path,
      });
      continue;
    }
    if (entryMap.has(entry.path)) {
      failures.push({
        type: "manifest_entry_duplicate",
        message: `Duplicate manifest entry: ${entry.path}`,
        path: entry.path,
      });
      continue;
    }
    entryMap.set(entry.path, entry.sha256);
  }

  for (const entryPath of packEntries.keys()) {
    if (!isSafeTarPath(entryPath)) {
      failures.push({
        type: "pack_entry_path_invalid",
        message: `Pack entry path is invalid: ${entryPath}`,
        path: entryPath,
      });
    }
  }

  const missingRequired: string[] = [];
  const inferredRequired =
    cycleId.startsWith("CY-") && cycleId !== "unknown"
      ? requiredCyclePackEntries(cycleId)
      : [];
  const required = (requiredEntries ?? inferredRequired)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, "/"));
  const requiredSorted = [...new Set(required)].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const entry of requiredSorted) {
    if (!entryMap.has(entry)) {
      missingRequired.push(entry);
    }
  }
  if (missingRequired.length) {
    failures.push({
      type: "missing_required",
      message: "Manifest missing required entries.",
    });
  }

  const packEntryPaths = [...packEntries.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const entry of packEntryPaths) {
    if (!entryMap.has(entry)) {
      failures.push({
        type: "pack_entry_unexpected",
        message: `Pack includes unexpected entry: ${entry}`,
        path: entry,
      });
    }
  }

  let verifiedCount = 0;
  for (const [entryPath, expectedSha] of [...entryMap.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const content = packEntries.get(entryPath);
    if (!content) {
      failures.push({
        type: "pack_entry_missing",
        message: `Pack missing entry: ${entryPath}`,
        path: entryPath,
      });
      continue;
    }
    const actualSha = hashBufferSha256(content);
    if (actualSha !== expectedSha) {
      failures.push({
        type: "pack_entry_sha_mismatch",
        message: `Pack entry sha256 mismatch: ${entryPath}`,
        path: entryPath,
        expected: expectedSha,
        actual: actualSha,
      });
      continue;
    }
    verifiedCount += 1;

    if (entryPath.endsWith(".json")) {
      try {
        const parsed = JSON.parse(content.toString("utf8"));
        const absolute: string[] = [];
        collectAbsolutePaths(parsed, absolute);
        if (absolute.length) {
          const unique = [...new Set(absolute)].sort((a, b) => a.localeCompare(b));
          for (const value of unique) {
            failures.push({
              type: "absolute_path",
              message: `Absolute path detected in ${entryPath}.`,
              path: entryPath,
              value,
            });
          }
        }
      } catch {
        failures.push({
          type: "json_parse_failed",
          message: `Unable to parse JSON entry: ${entryPath}`,
          path: entryPath,
        });
      }
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    schema_version: "pack-verify.v1",
    cycle_id: cycleId,
    pack_path: packRel,
    pack_sha256: packSha,
    manifest_path: manifestRel,
    verified_files_count: verifiedCount,
    required_files: requiredSorted,
    missing_required: [...new Set(missingRequired)].sort((a, b) =>
      a.localeCompare(b),
    ),
    failures,
  };
};
