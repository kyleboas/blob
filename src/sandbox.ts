import type { Env } from "./types";

export async function executeInSandbox(): Promise<never> {
  throw new Error("Sandbox disabled (Containers-on-Workers not enabled/bound for this Worker).");
}

export async function sandboxStatus(_env: Env): Promise<{ ready: boolean; message: string }> {
  return { ready: false, message: "Sandbox disabled" };
}