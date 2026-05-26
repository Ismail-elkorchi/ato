type EnvPrefixResult = {
  cmd: string[];
  env: Record<string, string>;
};

type Token = {
  value: string;
  quoted: boolean;
};

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INVALID_ENV_VALUE_RE = /[A-Z_][A-Z0-9_]*=/;

const tokenizeCommand = (raw: string): Token[] => {
  const tokens: Token[] = [];
  let buffer = "";
  let quoted = false;
  let inQuotes = false;
  let escaped = false;

  const pushToken = () => {
    if (!buffer) {
      quoted = false;
      return;
    }
    tokens.push({ value: buffer, quoted });
    buffer = "";
    quoted = false;
  };

  for (const ch of raw) {
    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }
    if (inQuotes && ch === "\\") {
      escaped = true;
      quoted = true;
      continue;
    }
    if (ch === "\"") {
      inQuotes = !inQuotes;
      quoted = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buffer += ch;
  }

  if (escaped) {
    buffer += "\\";
  }
  if (inQuotes) {
    throw new Error("Unterminated double-quote in command.");
  }
  pushToken();
  return tokens;
};

const normalizeEnv = (env: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

export const parseEnvPrefix = (raw: string): EnvPrefixResult => {
  const input = String(raw ?? "").trim();
  if (!input) {
    throw new Error("Missing acceptance command.");
  }
  const tokens = tokenizeCommand(input);
  if (!tokens.length) {
    throw new Error("Missing acceptance command.");
  }

  const env: Record<string, string> = {};
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    const eqIndex = token.value.indexOf("=");
    if (eqIndex === -1) break;
    const key = token.value.slice(0, eqIndex);
    const valueRaw = token.value.slice(eqIndex + 1);

    if (!ENV_KEY_RE.test(key)) {
      if (index === 0) {
        throw new Error(`Invalid env assignment '${token.value}'.`);
      }
      break;
    }
    if (valueRaw.length === 0) {
      throw new Error(`Empty env value for ${key}.`);
    }
    if (!token.quoted && INVALID_ENV_VALUE_RE.test(valueRaw)) {
      throw new Error(
        `Invalid env value for ${key}; missing whitespace between assignments.`,
      );
    }
    env[key] = valueRaw;
    index += 1;
  }

  if (index >= tokens.length) {
    throw new Error("Missing command after env prefix.");
  }

  const cmd = tokens.slice(index).map((token) => token.value);
  if (!cmd.length) {
    throw new Error("Missing command after env prefix.");
  }

  return { cmd, env: normalizeEnv(env) };
};

export type { EnvPrefixResult };
