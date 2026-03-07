import test from "node:test";
import assert from "node:assert/strict";
import worker from "../index";
import { getRuntimeControls } from "../core/runtime-controls";

function makeR2(contents?: string) {
  return {
    get: async (key: string) => {
      if (key !== "config/runtime-controls.json" || contents === undefined) return null;
      return { text: async () => contents };
    },
  } as any;
}

test("getRuntimeControls defaults when file is missing", async () => {
  const controls = await getRuntimeControls({ REPO_STORE: makeR2() } as any);
  assert.deepEqual(controls, { paused: false, reason: "" });
});

test("getRuntimeControls reads pause settings from config/runtime-controls.json", async () => {
  const controls = await getRuntimeControls({ REPO_STORE: makeR2('{"paused":true,"reason":"maintenance"}') } as any);
  assert.deepEqual(controls, { paused: true, reason: "maintenance" });
});

test("scheduled cron returns early when paused in runtime controls", async () => {
  let scanTargetsRead = false;
  const env = {
    REPO_STORE: {
      get: async (key: string) => {
        if (key === "config/runtime-controls.json") {
          return { text: async () => '{"paused":true,"reason":"manual pause"}' };
        }
        if (key === "config/scan-targets.json") {
          scanTargetsRead = true;
          return { json: async () => ({ sources: [] }) };
        }
        return null;
      },
    },
  } as any;

  await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledEvent, env);
  assert.equal(scanTargetsRead, false);
});
