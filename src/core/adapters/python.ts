import type { CoreAdapter } from "./types.js";

export const pythonAdapter: CoreAdapter = {
  id: "python",
  label: "Python",
  status: "disabled",
  executeStep: async () => {
    throw new Error("Adapter 'python' is present but disabled.");
  },
};
