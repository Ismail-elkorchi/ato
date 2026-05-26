import type { CoreAdapter } from "./types.js";

export const researchAdapter: CoreAdapter = {
  id: "research",
  label: "Research",
  status: "disabled",
  executeStep: async () => {
    throw new Error("Adapter 'research' is present but disabled.");
  },
};
