import { encoding_for_model, get_encoding } from "tiktoken";

// tiktoken uses WASM; Node 18+ is required even though policy sets a higher baseline.
type TokenOptions = {
  model?: string;
  encoding?: string;
};

export const countTokens = (
  text: unknown,
  options: TokenOptions = {},
): number => {
  const payload = text == null ? "" : String(text);
  const model = options.model ? String(options.model) : null;
  const encoding = options.encoding ? String(options.encoding) : "cl100k_base";
  const encoder = model
    ? encoding_for_model(model as Parameters<typeof encoding_for_model>[0])
    : get_encoding(encoding as Parameters<typeof get_encoding>[0]);
  try {
    return encoder.encode(payload).length;
  } finally {
    if (typeof encoder.free === "function") {
      encoder.free();
    }
  }
};
