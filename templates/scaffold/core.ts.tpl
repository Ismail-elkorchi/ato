export type {{pascalName}}Input = {
  name: string;
  description?: string;
};

export const {{camelName}} = (input: {{pascalName}}Input): string => {
  return input.name;
};
