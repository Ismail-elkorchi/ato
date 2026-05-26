import crypto from "node:crypto";

export const computeFingerprint = ({
  targetId,
  storeDir,
  seed,
}: {
  targetId: string;
  storeDir?: string;
  seed: string;
}): string => {
  if (!seed) {
    throw new Error("Missing fingerprint seed.");
  }
  const normalizedStore = storeDir ?? ".ato";
  const payload = `${targetId}|${normalizedStore}|${seed}`;
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return `${targetId}@${hash}`;
};
