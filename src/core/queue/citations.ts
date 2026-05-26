export const INPUT_CITATION_PREFIXES = ["file", "cmd", "log", "output"] as const;

export type InputCitationPrefix = (typeof INPUT_CITATION_PREFIXES)[number];
export const INPUT_CITATION_PATH_PREFIXES = ["file", "log", "output"] as const;

export const INPUT_CITATION_PREFIX_LABELS = INPUT_CITATION_PREFIXES.map(
  (prefix) => `${prefix}:`,
);

const joinWithOr = (values: readonly string[]): string => {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  const head = values.slice(0, -1).join(", ");
  const tail = values[values.length - 1];
  return `${head}, or ${tail}`;
};

export const INPUT_CITATION_PREFIX_MESSAGE =
  joinWithOr(INPUT_CITATION_PREFIX_LABELS);

export const INPUT_CITATION_HELP_PATTERN = INPUT_CITATION_PREFIX_LABELS.map(
  (label) => `${label}...`,
).join("|");

const INPUT_CITATION_RE = new RegExp(
  `^(${INPUT_CITATION_PREFIXES.join("|")}):(.+)$`,
  "i",
);

export const parseInputCitation = (
  value: string,
): { prefix: InputCitationPrefix; remainder: string } | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(INPUT_CITATION_RE);
  if (!match) return null;
  const prefix = (match[1] ?? "").toLowerCase() as InputCitationPrefix;
  const remainder = (match[2] ?? "").trim();
  if (!remainder) return null;
  return { prefix, remainder };
};

export const isInputCitation = (value: string): boolean =>
  parseInputCitation(value) !== null;

const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;

export const citationPrefixCarriesPath = (
  prefix: InputCitationPrefix,
): boolean =>
  (INPUT_CITATION_PATH_PREFIXES as readonly string[]).includes(prefix);

export const isAbsoluteCitationPath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed);
};

export const hasAbsoluteInputCitationPath = (value: string): boolean => {
  const citation = parseInputCitation(value);
  if (!citation) return false;
  if (!citationPrefixCarriesPath(citation.prefix)) return false;
  return isAbsoluteCitationPath(citation.remainder);
};
