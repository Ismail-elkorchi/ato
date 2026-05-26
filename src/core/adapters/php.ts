import type { CoreAdapter } from "./types.js";

export const phpAdapter: CoreAdapter = {
  id: "php",
  label: "PHP",
  status: "disabled",
  executeStep: async () => {
    throw new Error("Adapter 'php' is present but disabled.");
  },
};
