import { execSync } from "node:child_process";

const parseArgs = (args) => {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
};

const run = (cmd, options = {}) =>
  execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

const flags = parseArgs(process.argv.slice(2));
const mode =
  typeof flags.mode === "string" && flags.mode.trim()
    ? flags.mode.trim()
    : "build";

const before = new Set(run("git status --porcelain"));
const budgetMsRaw = flags["budget-ms"];
const budgetMs =
  typeof budgetMsRaw === "string" && budgetMsRaw.trim()
    ? Number(budgetMsRaw)
    : null;
const timeoutMs =
  typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0
    ? Math.floor(budgetMs)
    : null;

try {
  if (mode === "tsc") {
    execSync(
      "node ./node_modules/typescript/bin/tsc -p tsconfig.json --pretty false",
      {
        stdio: "inherit",
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      },
    );
  } else if (mode === "build") {
    execSync("npm run build", {
      stdio: "inherit",
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
  } else {
    console.error("Invalid --mode value. Use 'build' or 'tsc'.");
    process.exit(1);
  }
} catch (err) {
  const message = String(err?.message ?? "");
  const timedOut =
    err?.code === "ETIMEDOUT" || message.includes("ETIMEDOUT");
  if (timedOut) {
    console.error(`Determinism check timed out after ${timeoutMs}ms.`);
    process.exit(2);
  }
  throw err;
}

const after = new Set(run("git status --porcelain"));
const added = [...after].filter((line) => !before.has(line)).sort();

if (added.length) {
  console.error("Determinism check introduced new working tree changes:");
  added.forEach((line) => console.error(`- ${line}`));
  process.exit(1);
}

console.log("Determinism check did not introduce new working tree changes.");
