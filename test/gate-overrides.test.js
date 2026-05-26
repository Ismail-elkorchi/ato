import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGateConfig } from "../dist/core/gates/overrides.js";

test("per-project gate overrides apply for the selected target", () => {
  const config = {
    gates: {
      fast: [{ id: "lint", cmd: ["npm", "run", "lint"] }],
      overrides: {
        targets: {
          alpha: {
            fast: [{ id: "lint", cmd: ["echo", "override"] }],
          },
        },
      },
    },
  };

  const resolved = resolveGateConfig({ config, targetId: "alpha" });
  assert.equal(resolved.overrides.applied, true);
  assert.deepEqual(resolved.base.fast?.[0]?.cmd, ["npm", "run", "lint"]);
  assert.deepEqual(resolved.effective.fast?.[0]?.cmd, ["echo", "override"]);
});

test("no overrides are applied when none are configured for the target", () => {
  const config = {
    gates: {
      fast: [{ id: "lint", cmd: ["npm", "run", "lint"] }],
      overrides: { targets: { alpha: { fast: [{ id: "lint", cmd: ["echo", "override"] }] } } },
    },
  };

  const resolved = resolveGateConfig({ config, targetId: "beta" });
  assert.equal(resolved.overrides.applied, false);
  assert.deepEqual(resolved.effective.fast, resolved.base.fast);
});

test("invalid override shapes refuse deterministically", () => {
  const config = {
    gates: {
      overrides: {
        targets: {
          alpha: {
            fast: [{ id: "lint", cmd: "npm run lint" }],
          },
        },
      },
    },
  };

  assert.throws(
    () => resolveGateConfig({ config, targetId: "alpha" }),
    /cmd must be a non-empty string array/,
  );
});

test("unknown override keys refuse deterministically", () => {
  const config = {
    gates: {
      overrides: {
        targets: {
          alpha: {
            unknown: [],
          },
        },
      },
    },
  };

  assert.throws(
    () => resolveGateConfig({ config, targetId: "alpha" }),
    /unknown key 'unknown'/,
  );
});
