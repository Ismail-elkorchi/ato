import { mkdirSync } from "node:fs";
import path from "node:path";

export const resolveGateEnv = (
  root: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env = { ...baseEnv };
  delete env["ATO_TEST_TMPDIR_SOURCE"];
  if (!env["ATO_TEST_TMPDIR"] && !env["TMPDIR"]) {
    const repoTmp = path.resolve(root, ".ato", "tmp");
    env["TMPDIR"] = repoTmp;
    env["ATO_TEST_TMPDIR_SOURCE"] = "repo_default";
    mkdirSync(repoTmp, { recursive: true });
  }
  return env;
};
