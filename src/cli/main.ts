#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { VERSION } from "../core/version.js";

export type CliIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  cwd: () => string;
};

const HELP = `ATO

Usage:
  ato --help
  ato --version
  ato doctor

Commands:
  doctor       Check whether the current directory is ready for ATO work.

Options:
  -h, --help   Show this help.
  -v, --version
               Show the CLI version.
`;

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, text: string): void {
  stream.write(`${text}\n`);
}

export function run(argv = process.argv.slice(2), io: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd,
}): number {
  const [command] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(HELP);
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    writeLine(io.stdout, VERSION);
    return 0;
  }

  if (command === "doctor") {
    const cwd = io.cwd();
    const hasPackageJson = existsSync(join(cwd, "package.json"));
    const hasGit = existsSync(join(cwd, ".git"));
    writeLine(io.stdout, JSON.stringify({
      ok: hasGit,
      cwd,
      checks: {
        git: hasGit,
        packageJson: hasPackageJson,
      },
    }));
    return hasGit ? 0 : 1;
  }

  writeLine(io.stderr, `Unknown command: ${command}`);
  writeLine(io.stderr, "Run `ato --help` for usage.");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
