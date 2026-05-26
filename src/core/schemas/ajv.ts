import AjvModule from "ajv/dist/2020.js";
import type { Options } from "ajv";

type AjvConstructor = new (options?: Options) => {
  addFormat: (name: string, format: unknown) => void;
  compile: (
    schema: unknown,
  ) => ((data: unknown) => boolean) & {
    errors?: Array<{
      instancePath: string;
      schemaPath?: string;
      keyword?: string;
      params?: Record<string, unknown>;
      message?: string;
    }> | null;
  };
};

const Ajv2020 = AjvModule as unknown as AjvConstructor;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const createAjv = (options: Options = {}) => {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    ...options,
  });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => ISO_DATE_TIME_RE.test(value),
  });
  return ajv;
};
