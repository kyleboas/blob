import type { Env } from "./types";

export interface RuntimeControls {
  paused: boolean;
  reason: string;
}

const CONTROLS_KEY = "config/runtime-controls.json";

export async function getRuntimeControls(env: Env): Promise<RuntimeControls> {
  const defaults: RuntimeControls = { paused: false, reason: "" };

  try {
    const obj = await env.REPO_STORE.get(CONTROLS_KEY);
    if (!obj) return defaults;

    const parsed = JSON.parse(await obj.text()) as { paused?: unknown; reason?: unknown };
    return {
      paused: parsed.paused === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    console.error("getRuntimeControls failed", err);
    return defaults;
  }
}
