import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

const runCommand = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...options });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed: ${cmd} ${args.join(" ")}`));
    });
  });

const copyDir = async (source, dest) => {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      if (path.extname(entry.name) === ".ts") continue;
      await fs.copyFile(from, to);
    }
  }
};

const run = async () => {
  await fs.rm(distDir, { recursive: true, force: true });
  await runCommand("npx", ["tsc", "-p", "tsconfig.json"], { cwd: rootDir });
  await copyDir(srcDir, distDir);

  const mainPath = path.join(distDir, "cli", "main.js");
  await fs.chmod(mainPath, 0o755);
};

await run();
