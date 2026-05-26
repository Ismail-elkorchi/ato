import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnvPrefix } from "../dist/core/exec.js";

test("parseEnvPrefix handles multiple env assignments", () => {
  const result = parseEnvPrefix("A=1 B=2 npm test");
  assert.deepEqual(result.env, { A: "1", B: "2" });
  assert.deepEqual(result.cmd, ["npm", "test"]);
});

test("parseEnvPrefix allows values containing '='", () => {
  const result = parseEnvPrefix("C=a=b npm test");
  assert.deepEqual(result.env, { C: "a=b" });
  assert.deepEqual(result.cmd, ["npm", "test"]);
});

test("parseEnvPrefix supports quoted values with spaces", () => {
  const result = parseEnvPrefix('B="two words" npm test');
  assert.deepEqual(result.env, { B: "two words" });
  assert.deepEqual(result.cmd, ["npm", "test"]);
});

test("parseEnvPrefix handles commands without env prefixes", () => {
  const result = parseEnvPrefix("npm test");
  assert.deepEqual(result.env, {});
  assert.deepEqual(result.cmd, ["npm", "test"]);
});

test("parseEnvPrefix rejects malformed env prefixes", () => {
  assert.throws(
    () => parseEnvPrefix("=1 npm test"),
    /Invalid env assignment/,
  );
  assert.throws(() => parseEnvPrefix("A= npm test"), /Empty env value/);
  assert.throws(
    () => parseEnvPrefix("A=1B=2 npm test"),
    /missing whitespace between assignments/,
  );
});
