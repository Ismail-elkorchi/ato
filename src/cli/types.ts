export type CommandContext = {
  json: boolean;
  repo: string | null;
  store: string | null;
  pluginsEnabled: boolean;
};

export type CommandInput = {
  subcommand: string | null;
  args: string[];
  context: CommandContext;
};
