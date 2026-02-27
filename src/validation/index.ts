import type { ValidationPolicy } from "../config/policy";
import {
  resolveValidationCommands,
  type RepositoryCommandConfig,
  type ResolvedValidationCommand
} from "./commands";

export interface ValidationCheckResult {
  name: string;
  command: string;
  required: boolean;
  passed: boolean;
  output: string;
}

export interface ValidationRunResult {
  passed: boolean;
  blockedByRequiredCheck: boolean;
  checks: ValidationCheckResult[];
}

export type CommandExecutor = (command: string) => Promise<{ exitCode: number; output: string }>;

export async function runValidation(
  policy: ValidationPolicy,
  commandConfig: RepositoryCommandConfig,
  execute: CommandExecutor
): Promise<ValidationRunResult> {
  const resolvedCommands = new Map(
    resolveValidationCommands(commandConfig).map((entry) => [entry.name, entry])
  );

  const checks: ValidationCheckResult[] = [];
  let blockedByRequiredCheck = false;

  for (const policyCheck of policy.checks) {
    const resolvedCommand = resolvedCommands.get(policyCheck.name as ResolvedValidationCommand["name"]);
    const command = policyCheck.command ?? resolvedCommand?.command;
    if (!command) {
      checks.push({
        name: policyCheck.name,
        command: "",
        required: policyCheck.required,
        passed: !policyCheck.required,
        output: "No command configured"
      });
      blockedByRequiredCheck ||= policyCheck.required;
      continue;
    }

    const result = await execute(command);
    const passed = result.exitCode === 0;

    checks.push({
      name: policyCheck.name,
      command,
      required: policyCheck.required,
      passed,
      output: result.output
    });

    if (!passed && policyCheck.required) {
      blockedByRequiredCheck = true;
      if (policy.stopOnRequiredFailure) {
        break;
      }
    }
  }

  const passed = !blockedByRequiredCheck;

  return {
    passed,
    blockedByRequiredCheck,
    checks
  };
}
