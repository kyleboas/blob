import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SELF_HEALING_POLICY, mergeValidationPolicy } from "../config/policy";
import { resolveValidationCommands } from "./commands";
import { runValidation } from "./index";

describe("resolveValidationCommands", () => {
  it("uses sensible defaults when command config is missing", () => {
    const commands = resolveValidationCommands();
    expect(commands.find((command) => command.name === "test")?.command).toBe("npm test");
  });

  it("overrides configured commands", () => {
    const commands = resolveValidationCommands({ typecheck: "pnpm typecheck" });
    expect(commands.find((command) => command.name === "typecheck")?.command).toBe("pnpm typecheck");
  });
});

describe("runValidation", () => {
  it("passes when required checks pass", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: "ok" }));

    const result = await runValidation(
      DEFAULT_SELF_HEALING_POLICY.validation,
      { lint: "npm run lint", typecheck: "npm run typecheck", test: "npm test" },
      execute
    );

    expect(result.passed).toBe(true);
    expect(result.blockedByRequiredCheck).toBe(false);
    expect(result.checks.length).toBe(DEFAULT_SELF_HEALING_POLICY.validation.checks.length);
  });

  it("hard stops when required check fails", async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === "npm run typecheck") {
        return { exitCode: 1, output: "type errors" };
      }
      return { exitCode: 0, output: "ok" };
    });

    const policy = mergeValidationPolicy(DEFAULT_SELF_HEALING_POLICY.validation, [
      { name: "lint", required: true }
    ]);

    const result = await runValidation(
      policy,
      { lint: "npm run lint", typecheck: "npm run typecheck", test: "npm test" },
      execute
    );

    expect(result.passed).toBe(false);
    expect(result.blockedByRequiredCheck).toBe(true);
    expect(result.checks.at(-1)?.name).toBe("typecheck");
  });
});
