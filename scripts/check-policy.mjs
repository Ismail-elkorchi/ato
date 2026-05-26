import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const requiredFiles = [
  ".ato/contracts/ENGINEERING_POLICY.md",
  ".ato/library/ENGINEERING_POLICY_CHECKS.md",
  ".ato/library/ENGINEERING_POLICY_BASELINE.md",
];

const missing = [];
for (const relPath of requiredFiles) {
  const filePath = path.join(projectRoot, relPath);
  try {
    const content = readFileSync(filePath, "utf8");
    if (!content.trim()) missing.push(relPath);
  } catch {
    // Treat missing/unreadable files as policy violations.
    missing.push(relPath);
  }
}

const readJson = (relPath) => {
  const filePath = path.join(projectRoot, relPath);
  return JSON.parse(readFileSync(filePath, "utf8"));
};

let stabilityProfile = null;
try {
  const config = readJson(".ato/config.json");
  if (typeof config?.stabilityProfile === "string" && config.stabilityProfile.trim()) {
    stabilityProfile = config.stabilityProfile;
  }
} catch {
  // Keep stabilityProfile null if .ato/config.json cannot be read.
}

let packageProfileDeclared = false;
try {
  const pkg = readJson("package.json");
  if (
    pkg?.ato &&
    typeof pkg.ato === "object" &&
    Object.hasOwn(pkg.ato, "stabilityProfile")
  ) {
    packageProfileDeclared = true;
  }
} catch {
  // package.json may be absent in test fixtures.
}

const profileErrors = [];
if (!stabilityProfile) {
  profileErrors.push("Missing stabilityProfile in .ato/config.json.");
}
if (packageProfileDeclared) {
  profileErrors.push(
    "package.json must not declare ato.stabilityProfile; use .ato/config.json as the canonical source.",
  );
}

if (missing.length || profileErrors.length) {
  if (missing.length) {
    console.error("Missing or empty policy artifacts:");
    missing.sort().forEach((entry) => console.error(`- ${entry}`));
  }
  profileErrors.forEach((message) => console.error(message));
  process.exit(1);
}

console.log("Policy artifacts and canonical stability profile are present.");
