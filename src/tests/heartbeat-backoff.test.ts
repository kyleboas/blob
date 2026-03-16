import test from "node:test";
import assert from "node:assert/strict";
import { runHeartbeatAlarm } from "../agent/do-alarm";
import type { BlobState } from "../agent/do";
import type { Env } from "../core/types";

function makeState(shouldThrow = false) {
  let lastAlarm: number | null = null;
  const state = {
    storage: {
      sql: {
        exec: () => {
          if (shouldThrow) {
            throw new Error("heartbeat failed");
          }
          return [] as Array<Record<string, unknown>>;
        },
      },
      setAlarm: async (at: number) => {
        lastAlarm = at;
      },
      getAlarm: async () => lastAlarm,
    },
  } as unknown as DurableObjectState;

  return {
    state,
    getLastAlarm: () => lastAlarm,
  };
}

function makeEnv(): Env {
  return {
    AGENT_DO: {} as DurableObjectNamespace,
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => undefined,
      readFile: async () => "",
    },
    REPO_STORE: {
      get: async () => null,
    } as R2Bucket,
    HEARTBEAT_INTERVAL_MS: "1000",
    HEARTBEAT_BACKOFF_THRESHOLD: "3",
  } as Env;
}

test("heartbeat doubles interval after threshold failures and caps at 1 hour", async () => {
  const env = makeEnv();
  const { state, getLastAlarm } = makeState(true);
  const data: BlobState = { repos: [], goals: {}, messages: [], userPreferences: {} };

  for (let i = 0; i < 3; i += 1) {
    await runHeartbeatAlarm(state, env, data, async () => undefined);
  }

  assert.equal(data.heartbeat?.consecutiveHeartbeatFailures, 3);
  assert.equal(data.heartbeat?.currentIntervalMs, 2000);
  assert.ok((getLastAlarm() ?? 0) > Date.now());

  data.heartbeat = { ...(data.heartbeat ?? {}), currentIntervalMs: 3_600_000, consecutiveHeartbeatFailures: 3 };
  await runHeartbeatAlarm(state, env, data, async () => undefined);
  assert.equal(data.heartbeat?.currentIntervalMs, 3_600_000);
});

test("heartbeat success resets failure count and interval", async () => {
  const env = makeEnv();
  const { state } = makeState(false);
  const data: BlobState = {
    repos: [],
    goals: {},
    messages: [],
    userPreferences: {},
    heartbeat: { consecutiveHeartbeatFailures: 4, currentIntervalMs: 8000 },
  };

  await runHeartbeatAlarm(state, env, data, async () => undefined);

  assert.equal(data.heartbeat?.consecutiveHeartbeatFailures, 0);
  assert.equal(data.heartbeat?.currentIntervalMs, 1000);
});
