export interface RepositoryCommandConfig {
  lint?: string;
  typecheck?: string;
  test?: string;
}

export interface ResolvedValidationCommand {
  name: "lint" | "typecheck" | "test";
  command: string;
}

const DEFAULT_COMMANDS: Record<ResolvedValidationCommand["name"], string> = {
  lint: "npm run lint",
  typecheck: "npm run typecheck",
  test: "npm test"
};

const VALIDATION_COMMAND_NAMES: ResolvedValidationCommand["name"][] = ["lint", "typecheck", "test"];

export function resolveValidationCommands(
  config: RepositoryCommandConfig = {}
): ResolvedValidationCommand[] {
  return VALIDATION_COMMAND_NAMES.map((name) => ({
    name,
    command: config[name] ?? DEFAULT_COMMANDS[name]
  }));
}
