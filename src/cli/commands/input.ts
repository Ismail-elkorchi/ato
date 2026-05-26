import path from "node:path";
import { promises as fs } from "node:fs";

type JsonInputResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export const parseJsonInput = async (
  input: unknown,
): Promise<JsonInputResult> => {
  if (!input) return { ok: false, error: "Missing required --input." };
  const raw = String(input).trim();
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      return {
        ok: false,
        error: `Unable to parse JSON input: ${message}`,
      };
    }
  }
  const filePath = path.resolve(process.cwd(), raw);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    return {
      ok: false,
      error: `Unable to read --input ${raw}: ${message}`,
    };
  }
};
