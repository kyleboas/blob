import { handleProcessMessage } from "../agent/handlers/slack-message";
import type { SlackEventPayload } from "./slack-message-processing";
import type { Env } from "../core/types";

export async function processSlackMessage(body: SlackEventPayload, env: Env): Promise<void> {
  const req = new Request("http://do/process-message", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const ctx = {
    env,
    state: {} as any,
    data: { processedEvents: [] } as any,
    save: async () => {},
  };
  await handleProcessMessage(req, ctx);
}
