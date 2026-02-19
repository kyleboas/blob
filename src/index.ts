import { mapThreadToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

async function forwardToAgent(env: Env, threadTs: string, payload: { action: "message" | "reaction"; event: SlackEvent }): Promise<void> {
  const id = env.AGENT_DO.idFromName(mapThreadToDO(threadTs));
  const stub = env.AGENT_DO.get(id);

  const response = await stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Agent Durable Object request failed with status ${response.status}`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return new Response("not found", { status: 404 });
    }

    const verified = await verifySlackSignature(request, env.SLACK_SIGNING_SECRET);
    if (!verified) {
      return new Response("invalid signature", { status: 401 });
    }

    const body = await request.text();
    let envelope;
    try {
      envelope = parseSlackEvent(body);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (envelope.type === "url_verification") {
      return Response.json({ challenge: envelope.challenge ?? "" });
    }

    const event = envelope.event;
    if (!event) {
      return new Response("ok", { status: 200 });
    }

    if (event.type === "message") {
      const threadTs = event.thread_ts ?? event.ts;
      if (threadTs) {
        ctx.waitUntil(forwardToAgent(env, threadTs, { action: "message", event }));
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "reaction_added") {
      const threadTs = event.thread_ts ?? event.ts;
      if (threadTs) {
        ctx.waitUntil(forwardToAgent(env, threadTs, { action: "reaction", event }));
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  }
};
