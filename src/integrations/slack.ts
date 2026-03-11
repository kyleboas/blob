import type { Env } from "../core/types";
import { deriveRoutingKey, verifySlackSignature } from "./slack-routing";
import { createLogRef, logEvent } from "../core/observability";
import { redactSecrets } from "../core/safety";
import { classifyIntent, handleCommand } from "./slack-commands";
import { withDOAuth } from "../core/do-auth";
import type { SlackEventPayload } from "./slack-message-processing";

export async function handleSlackEvent(request: Request, env: Env, executionCtx?: ExecutionContext): Promise<Response> {
  try {
    if (env.SLACK_SIGNING_SECRET) {
      const verified = await verifySlackSignature(request, env.SLACK_SIGNING_SECRET);
      if (!verified) {
        logEvent(env, "slack_ingest", "signature_invalid");
        return new Response("Invalid Slack signature", { status: 401 });
      }
    }

    const body = await request.json() as SlackEventPayload;
    if (body.type === "url_verification" && body.challenge) {
      return new Response(body.challenge);
    }

    if (body.type === "event_callback" && env.AGENT_DO) {
      const key = deriveRoutingKey(body);
      const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName(key));
      const fetchPromise = do_.fetch("http://do/process-message", withDOAuth(env, {
        method: "POST",
        body: JSON.stringify(body),
      }));
      
      if (executionCtx) {
        executionCtx.waitUntil(fetchPromise);
      } else {
        await fetchPromise;
      }
      return new Response("OK");
    }

    return new Response("OK");
  } catch (err) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "handle_event_failed", { error: String(err) }, logRef);
    return new Response("Internal error", { status: 500 });
  }
}
