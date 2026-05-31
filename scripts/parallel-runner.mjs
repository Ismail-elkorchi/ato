import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const RUNNER_ID = "ato-parallel-runner";
const CONTENT_HASH_METHOD = "sha256(file_bytes)";
const REALPATH_HASH_METHOD = "sha256(path_string)";
const TEMP_PATH_HASH_METHOD = "sha256(path_string)";
const TEMP_RUN_DIR_NAME = ".ato-test";
const TEMP_SOURCE_AUTO = "auto:os.tmpdir";
const TEMP_SOURCE_ENV_TMPDIR = "env:TMPDIR";
const TEMP_SOURCE_ENV_ATO = "env:ATO_TEST_TMPDIR";
const TEMP_SOURCE_REPO_DEFAULT = "repo_default";
const TEMP_SOURCE_REASON_MISMATCH_IGNORED = "source_flag_mismatch_ignored";
const TEMP_SOURCE_ENUM = new Set([TEMP_SOURCE_REPO_DEFAULT]);

const parseOverride = (raw) => {
  if (!raw) return { value: null, source: "auto" };
  const normalized = String(raw).trim();
  if (normalized.toLowerCase() === "auto") {
    return { value: null, source: "auto" };
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      "ATO_TEST_CONCURRENCY must be an integer >= 1 when set.",
    );
  }
  return { value, source: "env" };
};

const detectParallelism = () => {
  const available =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  const normalized = Number.isFinite(available) ? Math.floor(available) : 1;
  return Math.max(1, normalized);
};

const detectedParallelism = detectParallelism();
let concurrency = detectedParallelism;
let source = "auto";
const rawArgs = process.argv.slice(2);

try {
  const override = parseOverride(process.env.ATO_TEST_CONCURRENCY);
  if (override.value !== null) {
    concurrency = override.value;
    source = "env";
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Invalid ATO_TEST_CONCURRENCY.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const resolveRunnerVersion = () => {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
};

export const computeArgvFingerprint = (args) =>
  crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex");

const normalizeTestFilePath = (filePath, baseDir = process.cwd()) =>
  path
    .relative(baseDir, path.resolve(baseDir, filePath))
    .split(path.sep)
    .join("/");

const ensureWithinRoot = (filePath, baseDir) => {
  const rel = normalizeTestFilePath(filePath, baseDir);
  if (rel.startsWith("..")) {
    throw new Error(`Test path outside repo root: ${filePath}`);
  }
  return rel;
};

const computePathHash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const resolveRealpathSafe = (value) => {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
};

const resolveRepoRelative = (absolutePath, baseDir) => {
  const rel = normalizeTestFilePath(absolutePath, baseDir);
  if (rel.startsWith("..")) return null;
  return rel || ".";
};

const normalizeRealpathForCompare = (value) => {
  const normalized = String(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

export const isRealpathContained = (rootRealpath, targetRealpath) => {
  const rootNormalized = normalizeRealpathForCompare(rootRealpath);
  const targetNormalized = normalizeRealpathForCompare(targetRealpath);
  if (process.platform === "win32") {
    const rootDrive = rootNormalized.slice(0, 2);
    const targetDrive = targetNormalized.slice(0, 2);
    if (
      /^[a-z]:$/.test(rootDrive) &&
      /^[a-z]:$/.test(targetDrive) &&
      rootDrive !== targetDrive
    ) {
      return {
        ok: false,
        relative: path.posix.relative(rootNormalized, targetNormalized),
      };
    }
  }
  const relative = path.posix.relative(rootNormalized, targetNormalized);
  if (!relative) {
    return { ok: true, relative: "" };
  }
  if (path.posix.isAbsolute(relative)) {
    return { ok: false, relative };
  }
  if (relative === ".." || relative.startsWith("../")) {
    return { ok: false, relative };
  }
  return { ok: true, relative };
};

const resolveTestPathInfo = (filePath, baseDir, repoRootRealpath) => {
  const normalized = ensureWithinRoot(filePath, baseDir);
  const absolutePath = path.resolve(baseDir, normalized);
  const resolvedRealpath = realpathSync.native(absolutePath);
  const containment = isRealpathContained(repoRootRealpath, resolvedRealpath);
  if (!containment.ok) {
    const payload = {
      test_file: normalized,
      resolved_realpath_hash: computePathHash(resolvedRealpath),
      resolved_realpath_hash_method: REALPATH_HASH_METHOD,
    };
    throw new Error(`test_path_escapes_repo ${JSON.stringify(payload)}`);
  }
  return {
    normalized,
    absolutePath,
    resolvedRealpath,
    resolvedRealpathHash: computePathHash(resolvedRealpath),
  };
};

export const computeTestFileId = (filePath, baseDir = process.cwd()) =>
  crypto
    .createHash("sha256")
    .update(normalizeTestFilePath(filePath, baseDir))
    .digest("hex");

export const computeTestContentSha256 = (
  filePath,
  baseDir = process.cwd(),
) => {
  const repoRootRealpath = resolveRealpathSafe(baseDir);
  const info = resolveTestPathInfo(filePath, baseDir, repoRootRealpath);
  const data = readFileSync(info.resolvedRealpath);
  return crypto.createHash("sha256").update(data).digest("hex");
};

export const resolveTempBinding = ({
  baseDir = process.cwd(),
  env = process.env,
  invocationId,
  ensureDir = false,
}) => {
  const readEnvPath = (key) => {
    const value = env[key];
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized.length ? normalized : null;
  };
  const readEnvEnum = (key, allowlist) => {
    const value = env[key];
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    return allowlist.has(normalized) ? normalized : null;
  };
  const envRoot = readEnvPath("ATO_TEST_TMPDIR");
  const envTmp = readEnvPath("TMPDIR");
  const envSource = readEnvEnum("ATO_TEST_TMPDIR_SOURCE", TEMP_SOURCE_ENUM);
  const repoDefaultRoot = path.resolve(baseDir, ".ato", "tmp");
  const repoDefaultRealpath = resolveRealpathSafe(repoDefaultRoot);
  const envTmpAbsolute = envTmp
    ? path.isAbsolute(envTmp)
      ? envTmp
      : path.resolve(baseDir, envTmp)
    : null;
  const envTmpRealpath = envTmpAbsolute
    ? resolveRealpathSafe(envTmpAbsolute)
    : null;
  const mismatchSourceFlag =
    envTmpRealpath &&
    envSource === TEMP_SOURCE_REPO_DEFAULT &&
    normalizeRealpathForCompare(envTmpRealpath) !==
      normalizeRealpathForCompare(repoDefaultRealpath);
  const rawRoot = envRoot ?? envTmp ?? os.tmpdir();
  const tempSource = envRoot
    ? TEMP_SOURCE_ENV_ATO
    : envTmp
      ? envSource === TEMP_SOURCE_REPO_DEFAULT && !mismatchSourceFlag
        ? TEMP_SOURCE_REPO_DEFAULT
        : TEMP_SOURCE_ENV_TMPDIR
      : TEMP_SOURCE_AUTO;
  const tempSourceReason = mismatchSourceFlag
    ? TEMP_SOURCE_REASON_MISMATCH_IGNORED
    : null;
  const tempRootAbsolute = path.isAbsolute(rawRoot)
    ? rawRoot
    : path.resolve(baseDir, rawRoot);
  const tempRunDirAbsolute = path.join(
    tempRootAbsolute,
    TEMP_RUN_DIR_NAME,
    invocationId,
  );
  if (ensureDir) {
    mkdirSync(tempRunDirAbsolute, { recursive: true });
  }
  const tempRootRealpath = resolveRealpathSafe(tempRootAbsolute);
  const tempRunDirRealpath = resolveRealpathSafe(tempRunDirAbsolute);
  const tempRootDisplay = resolveRepoRelative(tempRootAbsolute, baseDir);
  const tempRunDirDisplay = resolveRepoRelative(tempRunDirAbsolute, baseDir);
  return {
    temp_root: tempRootDisplay,
    temp_root_hash: computePathHash(tempRootRealpath),
    temp_root_hash_method: TEMP_PATH_HASH_METHOD,
    temp_source: tempSource,
    temp_source_reason: tempSourceReason,
    temp_run_dir: tempRunDirDisplay,
    temp_run_dir_sha256: computePathHash(tempRunDirRealpath),
    temp_run_dir_hash_method: TEMP_PATH_HASH_METHOD,
    temp_run_dir_absolute: tempRunDirAbsolute,
  };
};

const normalizePattern = (pattern) =>
  String(pattern).replace(/\\/g, "/");

const globToRegex = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexSource = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexSource}$`);
};

const isTestArg = (arg) => {
  const normalized = normalizePattern(arg);
  return (
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.mjs") ||
    normalized.includes(".test.js") ||
    normalized.includes(".test.mjs")
  );
};

export const discoverTestFiles = (args, baseDir = process.cwd()) => {
  const discovered = [];
  for (const arg of args) {
    if (!isTestArg(arg)) continue;
    const normalized = normalizePattern(arg);
    if (normalized.includes("*") || normalized.includes("?")) {
      const dir = path.posix.dirname(normalized);
      const basename = path.posix.basename(normalized);
      const matcher = globToRegex(basename);
      const absDir = path.resolve(baseDir, dir === "." ? "" : dir);
      const relDir = normalizeTestFilePath(absDir, baseDir);
      if (relDir.startsWith("..")) {
        throw new Error(`Test path outside repo root: ${normalized}`);
      }
      let entries = [];
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!matcher.test(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        discovered.push(ensureWithinRoot(rel, baseDir));
      }
    } else {
      discovered.push(ensureWithinRoot(normalized, baseDir));
    }
  }
  const unique = Array.from(new Set(discovered));
  return unique.sort((a, b) => a.localeCompare(b));
};

const splitArgs = (args, baseDir) => {
  const otherArgs = [];
  const testArgs = [];
  for (const arg of args) {
    if (isTestArg(arg)) {
      testArgs.push(arg);
    } else {
      otherArgs.push(arg);
    }
  }
  const discovered = discoverTestFiles(testArgs, baseDir);
  return { otherArgs, discovered };
};

const runnerPath = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(runnerPath);

const run = async () => {
  const runnerSha256 = crypto
    .createHash("sha256")
    .update(readFileSync(runnerPath))
    .digest("hex");
  const baseDir = process.cwd();
  const repoRootRealpath = realpathSync.native(baseDir);
  const { otherArgs, discovered } = splitArgs(rawArgs, baseDir);
  const executeList = discovered;
  const args = [...otherArgs, ...executeList];
  const argvFingerprint = computeArgvFingerprint(args);
  const invocationPayload = JSON.stringify({
    runner_sha256: runnerSha256,
    source,
    concurrency,
    args,
  });
  const invocationId = crypto
    .createHash("sha256")
    .update(invocationPayload)
    .digest("hex");
  const tempBinding = resolveTempBinding({
    baseDir,
    env: process.env,
    invocationId,
    ensureDir: true,
  });

  const header = {
    runner_id: RUNNER_ID,
    runner_version: resolveRunnerVersion(),
    runner_sha256: runnerSha256,
    invocation_id: invocationId,
    argv_fingerprint: argvFingerprint,
    temp_root: tempBinding.temp_root,
    temp_root_hash: tempBinding.temp_root_hash,
    temp_root_hash_method: tempBinding.temp_root_hash_method,
    temp_source: tempBinding.temp_source,
    temp_source_reason: tempBinding.temp_source_reason,
    temp_run_dir: tempBinding.temp_run_dir,
    temp_run_dir_sha256: tempBinding.temp_run_dir_sha256,
    temp_run_dir_hash_method: tempBinding.temp_run_dir_hash_method,
    concurrency,
    source,
    detected_parallelism: detectedParallelism,
    test_count: executeList.length,
  };

  const testEntries = executeList
    .map((filePath) => {
      const info = resolveTestPathInfo(filePath, baseDir, repoRootRealpath);
      const testFileId = computeTestFileId(filePath, baseDir);
      return {
        test_file: info.normalized,
        test_file_id: testFileId,
        repo_relative_path: info.normalized,
        resolved_realpath_hash: info.resolvedRealpathHash,
        resolved_realpath_hash_method: REALPATH_HASH_METHOD,
        temp_root: tempBinding.temp_root,
        temp_root_hash: tempBinding.temp_root_hash,
        temp_root_hash_method: tempBinding.temp_root_hash_method,
        temp_source: tempBinding.temp_source,
        temp_source_reason: tempBinding.temp_source_reason,
        temp_run_dir: tempBinding.temp_run_dir,
        temp_run_dir_sha256: tempBinding.temp_run_dir_sha256,
        temp_run_dir_hash_method: tempBinding.temp_run_dir_hash_method,
        content_hash_method: CONTENT_HASH_METHOD,
        test_content_sha256_before: null,
        test_content_sha256_after: null,
      };
    })
    .sort((a, b) => a.test_file.localeCompare(b.test_file));

  const childEnv = {
    ...process.env,
    ATO_RUNNER_INVOCATION_ID: invocationId,
    ATO_RUNNER_SHA256: runnerSha256,
    TMPDIR: tempBinding.temp_run_dir_absolute,
  };
  const stripChildEnv = (key) => {
    if (Object.prototype.hasOwnProperty.call(childEnv, key)) {
      delete childEnv[key];
    }
  };
  stripChildEnv("ATO_TEST_TMPDIR");
  stripChildEnv("ATO_TEST_TMPDIR_SOURCE");

  process.stdout.write(`${JSON.stringify(header)}\n`);

  const mutationErrors = [];
  let exitCode = 0;
  const queue = [...testEntries];
  const poolSize = Math.max(1, Math.min(concurrency, queue.length || 1));

  const runSingle = (entry) =>
    new Promise((resolve) => {
      let beforeHash = null;
      try {
        beforeHash = computeTestContentSha256(entry.test_file, baseDir);
        entry.test_content_sha256_before = beforeHash;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        exitCode = exitCode || 1;
        return resolve(1);
      }

      const child = spawn(
        process.execPath,
        ["--test", ...otherArgs, entry.test_file],
        { stdio: "inherit", env: childEnv },
      );

      child.on("error", (error) => {
        process.stderr.write(`${error.message}\n`);
        exitCode = exitCode || 1;
        resolve(1);
      });

      child.on("exit", (code) => {
        try {
          const afterHash = computeTestContentSha256(entry.test_file, baseDir);
          entry.test_content_sha256_after = afterHash;
          if (beforeHash && afterHash && beforeHash !== afterHash) {
            mutationErrors.push({
              test_file: entry.test_file,
              test_file_id: entry.test_file_id,
              before: beforeHash,
              after: afterHash,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`${message}\n`);
          exitCode = exitCode || 1;
        }
        if (typeof code === "number" && code !== 0) {
          exitCode = exitCode || code;
        }
        resolve(typeof code === "number" ? code : 1);
      });
    });

  const workers = Array.from({ length: poolSize }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      await runSingle(entry);
    }
  });
  await Promise.all(workers);

  if (mutationErrors.length) {
    mutationErrors.sort((a, b) =>
      String(a.test_file_id).localeCompare(String(b.test_file_id)),
    );
    const payload = {
      reason: "test_file_mutated_during_execution",
      entries: mutationErrors,
    };
    process.stderr.write(
      `test_file_mutated_during_execution ${JSON.stringify(payload)}\n`,
    );
    process.exit(1);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

if (isMain) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
