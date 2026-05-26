import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const parseHelpCommands = (helpText) => {
  const lines = helpText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === "Global options:",
  );
  if (start === -1 || end === -1) {
    throw new Error("Unable to locate Commands section in help output.");
  }
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const buildCapabilityMap = (entries) => {
  const map = new Map();
  for (const entry of entries) {
    const command = entry.command;
    const subcommand = entry.subcommand ? String(entry.subcommand) : null;
    if (!map.has(command)) {
      map.set(command, new Set());
    }
    map.get(command).add(subcommand);
  }
  return map;
};

const coverHelpLine = (command, raw, expectedSet) => {
  const covered = new Set();
  if (!raw) {
    covered.add(null);
    return covered;
  }

  const optional = raw.includes("[") && raw.includes("]");
  const cleaned = raw.replace(/\[|\]/g, "").trim();
  const segments = cleaned
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (optional) {
    covered.add(null);
  }

  if (!segments.length) {
    covered.add(null);
    return covered;
  }

  const firstSegment = segments[0] ?? "";
  const prefixTokens = firstSegment.split(" ");
  const prefix =
    prefixTokens.length > 1 ? prefixTokens.slice(0, -1).join(" ") : null;

  for (const segment of segments) {
    if (expectedSet.has(segment)) {
      covered.add(segment);
      continue;
    }
    if (prefix) {
      const prefixed = `${prefix} ${segment}`.trim();
      if (expectedSet.has(prefixed)) {
        covered.add(prefixed);
        continue;
      }
    }
    throw new Error(
      `Help line for '${command}' includes unknown subcommand segment '${segment}'.`,
    );
  }

  return covered;
};

test("help command inventory matches capability list", async () => {
  const cliPath = path.resolve("dist/cli/main.js");

  const helpResult = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(helpResult.status, 0, helpResult.stderr);

  const capResult = spawnSync(
    process.execPath,
    [cliPath, "--repo", ".", "capability", "list", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(capResult.status, 0, capResult.stderr);

  const capPayload = JSON.parse(capResult.stdout.trim());
  const entries = Array.isArray(capPayload.entries) ? capPayload.entries : [];
  const expected = buildCapabilityMap(entries);

  const commandLines = parseHelpCommands(helpResult.stdout);
  const covered = new Map();

  for (const line of commandLines) {
    const parts = line.split(" ");
    const command = parts[0];
    const raw = parts.slice(1).join(" ").trim();
    const expectedSet = expected.get(command);
    assert.ok(expectedSet, `Help lists unknown command '${command}'.`);
    const coveredSet = covered.get(command) ?? new Set();
    const lineCovered = coverHelpLine(command, raw, expectedSet);
    for (const entry of lineCovered) {
      coveredSet.add(entry);
    }
    covered.set(command, coveredSet);
  }

  for (const [command, expectedSet] of expected.entries()) {
    const coveredSet = covered.get(command);
    assert.ok(coveredSet, `Help missing command '${command}'.`);
    for (const entry of expectedSet) {
      assert.ok(
        coveredSet.has(entry),
        `Help missing subcommand '${command} ${entry ?? ""}'.`,
      );
    }
  }
});
